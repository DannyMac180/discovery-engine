import { StepHandler } from 'motia';
import Exa from 'exa-js';

// Define the expected input payload from the 'queries.generated' event
interface QueriesGeneratedPayload {
  traceId: string;
  queries: string[];
}

// Define the structure for a single search result
interface SearchResult {
  url: string;
  title: string;
  score: number; // Exa includes a relevance score
  publishedDate?: string; // Optional, if available
  author?: string; // Optional, if available
}

// Define the step configuration
export const config = {
  type: 'event',
  name: 'exa-searcher',
  description: 'Searches the web for relevant resources using generated queries via Exa Search.',
  subscribes: ['queries.generated'], // Listens for this event
  emits: ['search_results.obtained', 'exa.results.received'], // Emits this event upon completion
  flows: ['the-discovery-engine'],
};

// Helper function to delay execution (for basic rate limiting)
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The handler function for the event step
export const handler: StepHandler<typeof config> = async (payload, context) => {
  const { logger, state, event, secrets } = context;
  const { traceId, queries } = payload as QueriesGeneratedPayload;

  logger.info(`[${traceId}] Received 'queries.generated' event with ${queries.length} queries.`);

  const apiKey = secrets.EXA_API_KEY;
  if (!apiKey) {
    logger.error(`[${traceId}] Exa API key is missing. Check environment variables and motia.config.ts secrets.`);
    await event.emit('workflow.error', { traceId, step: config.name, error: 'Missing Exa API Key' });
    return;
  }

  const exa = new Exa(apiKey);
  const allResults: SearchResult[] = [];
  const errors: string[] = [];

  // Process each query
  for (const query of queries) {
    try {
      logger.debug(`[${traceId}] Searching Exa for query: "${query}"`);
      // Using search method, asking for top 5 results
      const searchResponse = await exa.search(query, {
        numResults: 5, // Limit results per query
        type: 'neural', // Use neural search for relevance
        useAutoprompt: true, // Let Exa optimize the query if needed
        // Potentially add date constraints if needed: startPublishedDate, endPublishedDate
      });

      logger.debug(`[${traceId}] Found ${searchResponse.results.length} results for query "${query}"`);

      // Map Exa results to our desired structure
      const queryResults: SearchResult[] = searchResponse.results.map(result => ({
        url: result.url,
        title: result.title || 'No title provided',
        score: result.score,
        publishedDate: result.publishedDate,
        author: result.author,
        // Consider extracting snippets if needed and available in the result object
      }));

      allResults.push(...queryResults);

      // Basic rate limiting: Wait a short time between requests
      await delay(500); // Wait 500ms before the next query

    } catch (error) {
      logger.error(`[${traceId}] Error searching Exa for query "${query}": ${error}`);
      errors.push(`Query "${query}": ${error.message}`);
      // Optional: Implement retry logic here
    }
  }

  if (allResults.length === 0 && errors.length > 0) {
      logger.error(`[${traceId}] Failed to get any search results. Errors: ${errors.join('; ')}`);
      await event.emit('workflow.error', { traceId, step: config.name, error: `Failed to get results for any query. First error: ${errors[0]}` });
      return;
  }

  logger.info(`[${traceId}] Aggregated ${allResults.length} search results from ${queries.length} queries.`);

  // Store the aggregated results in state
  const stateKey = `${traceId}:search_results`;
  await state.set(stateKey, allResults);
  logger.debug(`[${traceId}] Stored search results in state at key: ${stateKey}`);

  // Emit the 'search_results.obtained' event
  await event.emit('search_results.obtained', {
    traceId: traceId,
    results: allResults,
    errors: errors, // Include any errors encountered
  });
  logger.info(`[${traceId}] Emitted 'search_results.obtained' event.`);
};
