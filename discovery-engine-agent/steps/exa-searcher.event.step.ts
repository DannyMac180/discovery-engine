import * as dotenv from 'dotenv';
import * as path from 'path';

// Explicitly load .env from the project root relative to this file's location
const projectRoot = path.resolve(__dirname, '..', '..'); // Assumes steps are one level down from root
const envPath = path.join(projectRoot, '.env');
const dotenvResult = dotenv.config({ path: envPath });

// Log dotenv loading status (do this *before* logger is destructured from context)
console.log(`[dotenv-debug] [exa-searcher] Attempting to load .env from: ${envPath}`);
if (dotenvResult.error) {
  console.error(`[dotenv-debug] [exa-searcher] Error loading .env file: ${dotenvResult.error.message}`);
} else if (dotenvResult.parsed) {
  console.log(`[dotenv-debug] [exa-searcher] .env file loaded successfully. Found keys: ${Object.keys(dotenvResult.parsed).join(', ')}`);
  if (!dotenvResult.parsed.EXA_API_KEY) {
    console.warn('[dotenv-debug] [exa-searcher] EXA_API_KEY was NOT found in the parsed .env file.');
  }
} else {
  console.warn('[dotenv-debug] [exa-searcher] .env file loaded but dotenvResult.parsed is empty.');
}

import { StepHandler } from '@motiadev/core'; 
import Exa from 'exa-js';

// Define the expected input payload from the 'queries.generated' event
interface QueriesGeneratedPayload {
  traceId: string;
  queries: string[];
}

// Define the structure for search results from Exa
interface SearchResult {
  url: string;
  title: string;
  id: string;
  publishedDate?: string;
  author?: string;
  score?: number;
  // Add other relevant fields from Exa response if needed
}

// Define the step configuration
export const config = {
  type: 'event',
  name: 'exa-searcher',
  description: 'Searches Exa based on generated queries.',
  subscribes: ['queries.generated'],
  emits: ['search_results.obtained'],
  flows: ['the-discovery-engine'],
};

// The handler function for the event step
export const handler: StepHandler<typeof config> = async (payload, context) => {
  // Destructure context, including emit for event steps
  const { logger, state, emit } = context; 
  const { traceId, queries } = payload as QueriesGeneratedPayload;

  logger.info(`[${traceId}] Received 'queries.generated' event with ${queries.length} queries.`);

  const exaApiKey = process.env.EXA_API_KEY;

  if (!exaApiKey) {
    logger.error(`[${traceId}] Exa API key is missing. Ensure EXA_API_KEY environment variable is set.`);
    logger.debug(`[${traceId}] Value of process.env.EXA_API_KEY at check: ${process.env.EXA_API_KEY}`);
    // Emit error using the destructured emit function and correct format
    if (emit && typeof emit === 'function') { 
      await emit({ topic: 'workflow.error', data: { traceId, step: config.name, error: 'Missing Exa API Key' } });
    } else {
      logger.error(`[${traceId}] Could not emit workflow.error because emit function is unavailable in context.`);
    }
    return;
  }

  const exa = new Exa(exaApiKey);
  const allResults: SearchResult[] = [];
  const errors: string[] = [];

  logger.debug(`[${traceId}] Starting Exa search for ${queries.length} queries...`);

  // Process each query - consider running in parallel for efficiency
  for (const query of queries) {
    try {
      logger.debug(`[${traceId}] Searching Exa for query: "${query}"`);
      const results = await exa.searchAndContents(query, {
        numResults: 5, // Adjust as needed
        type: 'neural', // Use neural search for relevance
        useAutoprompt: true, // Let Exa optimize the query
        // Add other relevant Exa parameters like startPublishedDate, etc.
      });

      if (results.results && results.results.length > 0) {
        logger.debug(`[${traceId}] Found ${results.results.length} results for query: "${query}"`);
        // Map Exa results to our SearchResult interface
        results.results.forEach(res => {
          allResults.push({
            url: res.url,
            title: res.title,
            id: res.id,
            publishedDate: res.publishedDate,
            author: res.author,
            score: res.score,
          });
        });
      } else {
         logger.warn(`[${traceId}] No Exa results found for query: "${query}"`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[${traceId}] Error searching Exa for query "${query}": ${errorMessage}`);
      errors.push(`Query: "${query}" - Error: ${errorMessage}`);
      // Optionally log the full error object for more details
      // logger.error(`[${traceId}] Full Exa search error object:`, error);
    }
  }

  logger.info(`[${traceId}] Exa search completed. Found ${allResults.length} total results across all queries.`);

  // Handle cases where no results were found or only errors occurred
  if (allResults.length === 0) {
    const errorMsg = errors.length > 0 ? `Failed to get results for any query. First error: ${errors[0]}` : 'No search results found for any query.';
    logger.error(`[${traceId}] ${errorMsg}`);
    // Emit error using the destructured emit function and correct format
    if (emit && typeof emit === 'function') { 
      await emit({ topic: 'workflow.error', data: { traceId, step: config.name, error: errorMsg } });
    } else {
      logger.error(`[${traceId}] Could not emit workflow.error because emit function is unavailable in context.`);
    }
    return;
  }

  // Store the combined results in state
  const stateKey = `${traceId}:exa_search_results`;
  await state.set(stateKey, allResults);
  logger.debug(`[${traceId}] Stored ${allResults.length} Exa search results in state at key: ${stateKey}`);

  // Emit the 'search_results.obtained' event using the { topic, data } structure
  const emitPayload = { traceId, results: allResults, errors: errors }; 
  const eventName = 'search_results.obtained'; 
  logger.debug(`[${traceId}] Preparing to emit '${eventName}' with traceId: ${traceId}`);
  await emit({ 
    topic: eventName, 
    data: emitPayload,
  });
  logger.debug(`[${traceId}] Emitted '${eventName}' event.`);
};
