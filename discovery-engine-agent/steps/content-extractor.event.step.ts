import { StepHandler } from 'motia';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

// Define the expected input payload from the 'search_results.obtained' event
interface SearchResultsObtainedPayload {
  traceId: string;
  results: { url: string; title: string; score: number }[]; // Array of search results
  errors: string[]; // Errors from the previous step
}

// Define the structure for extracted content
interface ExtractedContent {
  url: string;
  title: string; // Carry over the title
  content: string; // The main text content
  excerpt?: string; // Readability often provides this
  length?: number; // Length of the extracted content
  error?: string; // Record errors for specific URLs
}

// Define the step configuration
export const config = {
  type: 'event',
  name: 'content-extractor',
  description: 'Fetches web pages from search results and extracts main content using Readability.',
  subscribes: ['exa.results.received'],
  emits: ['content.extracted'],
  flows: ['the-discovery-engine'],
};

// Helper function to delay execution (for retries)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The handler function for the event step
export const handler: StepHandler<typeof config> = async (payload, context) => {
  const { logger, state, event } = context;
  const { traceId, results, errors: searchErrors } = payload as SearchResultsObtainedPayload;

  logger.info(`[${traceId}] Received 'search_results.obtained' event with ${results.length} results.`);
  if (searchErrors && searchErrors.length > 0) {
    logger.warn(`[${traceId}] Previous step encountered errors: ${searchErrors.join('; ')}`);
  }

  const extractedContents: ExtractedContent[] = [];
  const MAX_RETRIES = 2;
  const RETRY_DELAY = 1000; // 1 second delay between retries

  for (const result of results) {
    let success = false;
    let attempt = 0;
    let extracted: ExtractedContent | null = null;

    while (attempt < MAX_RETRIES + 1 && !success) {
      attempt++;
      try {
        logger.debug(`[${traceId}] Fetching URL (Attempt ${attempt}/${MAX_RETRIES+1}): ${result.url}`);
        // Dynamically import node-fetch
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(result.url, {
            headers: { // Add a User-Agent to mimic a browser
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            redirect: 'follow', // Follow redirects
            timeout: 15000, // 15 second timeout
        });

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status} for ${result.url}`);
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/html')) {
            logger.warn(`[${traceId}] Skipping non-HTML content type (${contentType}) for URL: ${result.url}`);
            extracted = { url: result.url, title: result.title, content: '', error: `Skipped non-HTML content type: ${contentType}` };
            success = true; // Mark as success to stop retries, but content is empty/error state
            continue; // Move to the next result
        }

        const html = await response.text();
        const dom = new JSDOM(html, { url: result.url }); // Provide URL for relative path resolution
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (article && article.textContent) {
          extracted = {
            url: result.url,
            title: article.title || result.title, // Prefer Readability's title if available
            content: article.textContent.trim(),
            excerpt: article.excerpt,
            length: article.length,
          };
          logger.debug(`[${traceId}] Successfully extracted content from ${result.url} (Length: ${article.length})`);
          success = true;
        } else {
          throw new Error(`Readability could not extract content from ${result.url}`);
        }

      } catch (error) {
        logger.warn(`[${traceId}] Error processing URL ${result.url} (Attempt ${attempt}): ${error.message}`);
        extracted = { url: result.url, title: result.title, content: '', error: error.message }; // Store error for this URL
        if (attempt <= MAX_RETRIES) {
          await delay(RETRY_DELAY);
        }
      }
    }
    // Add the result (either successful extraction or final error state) to the list
    if (extracted) {
        extractedContents.push(extracted);
    }
  }

  const successfulExtractions = extractedContents.filter(c => !c.error);
  const failedExtractions = extractedContents.filter(c => c.error);

  logger.info(`[${traceId}] Successfully extracted content from ${successfulExtractions.length} URLs. Failed or skipped ${failedExtractions.length} URLs.`);
  failedExtractions.forEach(f => logger.warn(`[${traceId}] Failed URL: ${f.url} - Reason: ${f.error}`));

  // Store the extracted content (including errors) in state
  const stateKey = `${traceId}:extracted_content`;
  await state.set(stateKey, extractedContents);
  logger.debug(`[${traceId}] Stored extracted content in state at key: ${stateKey}`);

  // Emit the 'content.extracted' event
  await event.emit('content.extracted', {
    traceId: traceId,
    extractedContent: extractedContents,
  });
  logger.info(`[${traceId}] Emitted 'content.extracted' event.`);
};
