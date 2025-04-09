import { StepHandler } from 'motia';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { AbortController } from 'node-abort-controller'; // For timeout

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

// Define the expected context shape for this event step
interface CustomEventContext {
  logger: any; // Replace 'any' with specific Motia Logger type if known/available
  state: any;  // Replace 'any' with specific Motia State type if known/available
  emit: (event: { topic: string; data: any }) => Promise<void>;
}

// Define the step configuration
export const config = {
  type: 'event',
  name: 'content-extractor',
  description: 'Fetches web pages from search results and extracts main content using Readability.',
  subscribes: ['search_results.obtained'],
  emits: ['content.extracted'],
  flows: ['the-discovery-engine'],
};

// Helper function to delay execution (for retries)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The handler function for the event step
export const handler: StepHandler<typeof config> = async (payload: SearchResultsObtainedPayload, context: CustomEventContext) => {
  const { logger, state, emit } = context;

  logger.info(`[${payload.traceId}] Received 'search_results.obtained' event with ${payload.results.length} results.`);
  if (payload.errors && payload.errors.length > 0) {
    logger.warn(`[${payload.traceId}] Previous step encountered errors: ${payload.errors.join('; ')}`);
  }

  const extractedContents: ExtractedContent[] = [];
  const errors: { url: string; error: string }[] = [];

  const MAX_RETRIES = 2;
  const RETRY_DELAY = 1000; // 1 second delay between retries
  const FETCH_TIMEOUT = 15000; // 15 seconds

  for (const result of payload.results) { // Switched back to sequential for simplicity
    if (!result.url) {
      logger.warn(`[${payload.traceId}] Skipping result with missing URL.`);
      continue;
    }

    let success = false;
    let attempt = 0;
    let extracted: ExtractedContent | null = null;

    while (attempt < MAX_RETRIES + 1 && !success) {
      attempt++;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      try {
        logger.debug(`[${payload.traceId}] Fetching URL (Attempt ${attempt}/${MAX_RETRIES + 1}): ${result.url}`);

        const fetch = (await import('node-fetch')).default;
        const response = await fetch(result.url, {
          signal: controller.signal, // Attach the AbortController signal
          headers: {
            'User-Agent': 'ResearchAgent/1.0' // Be polite
          },
          redirect: 'follow',
        });

        clearTimeout(timeoutId); // Clear timeout if fetch completes

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status} for ${result.url}`);
        }

        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('text/html')) {
          logger.warn(`[${payload.traceId}] Skipping non-HTML content type (${contentType}) for URL: ${result.url}`);
          extracted = { url: result.url, title: result.title, content: '', error: `Skipped non-HTML content type: ${contentType}` };
          success = true;
          continue;
        }

        const html = await response.text();
        const dom = new JSDOM(html, { url: result.url });
        const reader = new Readability(dom.window.document);
        const article = reader.parse();

        if (article && article.textContent) {
          extracted = {
            url: result.url,
            title: article.title || result.title,
            content: article.textContent.trim(),
            excerpt: article.excerpt,
            length: article.length,
          };
          logger.debug(`[${payload.traceId}] Successfully extracted content from ${result.url} (Length: ${article.length})`);
          success = true;
        } else {
          throw new Error(`Readability could not extract content from ${result.url}`);
        }

      } catch (error: unknown) {
        clearTimeout(timeoutId); // Clear timeout if fetch fails
        let errorMessage = 'Unknown error';
        if (error instanceof Error) {
            errorMessage = error.message;
            if (error.name === 'AbortError') {
                errorMessage = `Fetch timed out after ${FETCH_TIMEOUT / 1000}s`;
            }
        }
        logger.warn(`[${payload.traceId}] Error processing URL ${result.url} (Attempt ${attempt}): ${errorMessage}`);
        extracted = { url: result.url, title: result.title, content: '', error: errorMessage };
        if (attempt <= MAX_RETRIES) {
          await delay(RETRY_DELAY);
        }
      }
    }
    if (extracted) {
      extractedContents.push(extracted);
    }
  }

  const successfulExtractions = extractedContents.filter(c => !c.error);
  const failedExtractions = extractedContents.filter(c => c.error);

  logger.info(`[${payload.traceId}] Successfully extracted content from ${successfulExtractions.length} URLs. Failed or skipped ${failedExtractions.length} URLs.`);
  failedExtractions.forEach(f => logger.warn(`[${payload.traceId}] Failed URL: ${f.url} - Reason: ${f.error}`));

  const stateKey = `${payload.traceId}:extracted_content`;
  await state.set(stateKey, extractedContents);
  logger.debug(`[${payload.traceId}] Stored extracted content in state at key: ${stateKey}`);

  await emit({
    topic: 'content.extracted',
    data: {
      traceId: payload.traceId,
      extractedContent: extractedContents,
    }
  });
  logger.info(`[${payload.traceId}] Emitted 'content.extracted' event.`);
};
