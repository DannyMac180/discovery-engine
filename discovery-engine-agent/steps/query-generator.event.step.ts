import * as dotenv from 'dotenv';
import * as path from 'path';

// Explicitly load .env from the project root relative to this file's location
const projectRoot = path.resolve(__dirname, '..', '..'); // Assumes steps are one level down from root
const envPath = path.join(projectRoot, '.env');
const dotenvResult = dotenv.config({ path: envPath });

// Log dotenv loading status (do this *before* logger is destructured from context)
console.log(`[dotenv-debug] Attempting to load .env from: ${envPath}`);
if (dotenvResult.error) {
  console.error(`[dotenv-debug] Error loading .env file: ${dotenvResult.error.message}`);
} else if (dotenvResult.parsed) {
  console.log(`[dotenv-debug] .env file loaded successfully. Found keys: ${Object.keys(dotenvResult.parsed).join(', ')}`);
  if (!dotenvResult.parsed.OPENAI_API_KEY) {
    console.warn('[dotenv-debug] OPENAI_API_KEY was NOT found in the parsed .env file.');
  }
} else {
  console.warn('[dotenv-debug] .env file loaded but dotenvResult.parsed is empty.');
}

import { StepHandler } from '@motiadev/core';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { z } from 'zod';
import { createJsonTranslator, TypeProvider } from 'typechat';

// Define the expected input payload from the 'topic.seeded' event
interface TopicSeededPayload {
  traceId: string;
  topic: string;
}

// Define the step configuration
export const config = {
  type: 'event',
  name: 'query-generator',
  description: 'Generates search queries based on a seed topic using OpenAI.',
  subscribes: ['topic.seeded'], // Listen only for the initial topic
  emits: ['queries.generated', 'workflow.error'], // Emits this event upon completion
  flows: ['the-discovery-engine'],
};

// The handler function for the event step
export const handler: StepHandler<typeof config> = async (payload, context) => {
  // Destructure context immediately, including emit for event steps
  const { logger, state, emit } = context;
  const { traceId, topic } = payload as TopicSeededPayload;

  logger.info(`[${traceId}] Received 'topic.seeded' event for topic: "${topic}"`);

  const apiKey = process.env.OPENAI_API_KEY; // Get key from process.env
  if (!apiKey) {
    logger.error(`[${traceId}] OpenAI API key is missing. Ensure OPENAI_API_KEY environment variable is set and .env is loaded.`);
    logger.debug(`[${traceId}] Value of process.env.OPENAI_API_KEY at check: ${process.env.OPENAI_API_KEY}`);
    // Optional: Emit an error event or handle differently
    // Check if emit exists before emitting (using the destructured emit)
    if (emit && typeof emit === 'function') {
      await emit({ topic: 'workflow.error', data: { traceId, step: config.name, error: 'Missing OpenAI API Key' } });
    } else {
      logger.error(`[${traceId}] Could not emit workflow.error because emit function is unavailable in context.`);
    }
    return; // Stop processing if key is missing
  }

  const openai = new OpenAI({
    apiKey,
    timeout: 90 * 1000, // 90 seconds timeout
  });

  // Design the prompt for query generation
  const prompt = `Given the research seed topic "${topic}", generate 3 to 5 diverse and specific search engine queries that would be effective for finding relevant scientific papers, articles, and datasets. Focus on different angles or sub-topics related to the seed topic. Output the queries as a JSON array of strings. Example format: ["query 1", "query 2", "query 3"]`;

  try {
    logger.debug(`[${traceId}] Sending request to OpenAI...`);
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: 'You are an AI assistant specialized in generating effective search queries for scientific research.' },
      { role: 'user', content: prompt },
    ];

    const requestPayload = {
      model: 'gpt-4o-mini', // Or 'gpt-4' if preferred
      messages: messages,
      temperature: 0.7, // Adjust for creativity vs. focus
      max_tokens: 150,
      response_format: { type: "json_object" as const }, // Corrected Type Literal
    };

    logger.debug(`[${traceId}] Sending request to OpenAI with payload: ${JSON.stringify(requestPayload, null, 2)}`);
    const response = await openai.chat.completions.create(requestPayload);

    logger.debug(`[${traceId}] Received response from OpenAI.`);
    logger.debug(`[${traceId}] Raw response from OpenAI: ${JSON.stringify(response, null, 2)}`);

    const rawQueries = response.choices[0]?.message?.content;
    logger.debug(`[${traceId}] Raw response from OpenAI: ${rawQueries}`);

    if (!rawQueries) {
      throw new Error('OpenAI response content is empty.');
    }

    // Parse the JSON response
    let generatedQueries: string[] = [];
    try {
      // Assuming the response is a JSON object containing an array, e.g., { "queries": [...] }
      // Adjust parsing based on actual model output structure if response_format isn't perfect.
      const parsedResponse = JSON.parse(rawQueries);
      // Look for a common key like 'queries' or assume the top-level object is the array
      if (Array.isArray(parsedResponse)) {
        generatedQueries = parsedResponse.filter(q => typeof q === 'string');
      } else if (parsedResponse.queries && Array.isArray(parsedResponse.queries)) {
        generatedQueries = parsedResponse.queries.filter(q => typeof q === 'string');
      } else {
         throw new Error('Could not find expected queries array in OpenAI JSON response.');
      }
    } catch (parseError) {
      logger.error(`[${traceId}] Failed to parse JSON response from OpenAI: ${parseError}`);
      // Attempt to extract queries using regex as a fallback if parsing fails
      generatedQueries = rawQueries.match(/"(.*?)"/g)?.map(q => q.replace(/"/g, '')) || [];
      if (generatedQueries.length === 0) {
         throw new Error(`Could not parse or extract queries from OpenAI response: ${rawQueries}`);
      }
      logger.warn(`[${traceId}] Fallback extraction used for OpenAI queries.`);
    }

    if (generatedQueries.length === 0) {
      throw new Error('No valid queries were generated or extracted.');
    }

    logger.info(`[${traceId}] Generated ${generatedQueries.length} queries.`);

    // Store the generated queries in state
    const stateKey = `${traceId}:generated_queries`;
    await state.set(stateKey, generatedQueries);
    logger.debug(`[${traceId}] Stored generated queries in state at key: ${stateKey}`);

    // Emit the 'queries.generated' event using the { topic, data } structure
    await emit({ 
      topic: 'queries.generated', 
      data: { traceId: traceId, queries: generatedQueries },
    });
    logger.debug(`[${traceId}] Emitted 'queries.generated' event.`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[${traceId}] Error during query generation: ${errorMessage}`);
    logger.error(`[${traceId}] Full Error Object:`, error);
    // Optional: Emit an error event
    // Check if emit exists before emitting
    if (emit && typeof emit === 'function') { 
      await emit({ 
        topic: 'workflow.error', 
        data: { traceId, step: config.name, error: errorMessage },
      });
    } else {
      logger.error(`[${traceId}] Could not emit workflow.error because emit function is unavailable in context.`);
    }
  }
};
