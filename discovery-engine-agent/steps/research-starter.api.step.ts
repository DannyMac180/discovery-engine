import { StepHandler } from 'motia'; // Base type if needed
import { randomUUID } from 'crypto'; // For generating unique trace IDs

// Define the expected input shape based on bodySchema
interface ResearchStarterInput {
  body: {
    seed_topic: string;
  };
  // Add other potential API input parts if needed, though not used here
  params?: Record<string, string>;
  query?: Record<string, string>;
}

// Define the expected context shape for this API step
interface CustomApiContext {
  logger: any; // Replace 'any' with specific Motia Logger type if known/available
  state: {
    set: (key: string, value: any) => Promise<void>; // Add type hint for set
    get: <T>(key: string) => Promise<T | undefined>; // Add type hint for get
  };
  // Assume emit is directly on context for API steps
  emit: (eventName: string, payload: any) => Promise<void>;
}

// Define the API endpoint configuration
export const config = {
  type: 'api',
  name: 'research-starter',
  description: 'API endpoint to start a new research workflow.',
  path: '/start-research', 
  method: 'POST', 
  emits: ['topic.seeded'], 
  bodySchema: {
    type: 'object',
    properties: {
      seed_topic: { type: 'string', minLength: 1 },
    },
    required: ['seed_topic'],
    additionalProperties: false,
  },
  flows: ['the-discovery-engine'],
};

// The handler function for the API step - Remove explicit types for now
export const handler = async (input: ResearchStarterInput, context: any) => { // Use any for context
  const { logger, state } = context; // Destructure only logger and state
  // Rely on motia's validation via bodySchema
  const body = input.body;

  logger.info(`Received request to start research for topic: "${body.seed_topic}"`); // Fixed escaping

  // 1. Generate a unique traceId
  const traceId = randomUUID();
  logger.debug(`Generated traceId: ${traceId}`);

  logger.info('Received research request', { topic: body.seed_topic, traceId });

  // Store the initial topic in state, scoped by traceId
  await state.set(`${traceId}:seed_topic`, body.seed_topic);
  logger.debug(`Stored seed topic for traceId ${traceId}`);

  // Define event details
  const eventName = 'topic.seeded';
  const payload = {
    traceId: traceId,
    topic: body.seed_topic,
  };

  // Emit the 'topic.seeded' event using the correct API step structure
  try {
    await context.emit({ topic: eventName, data: payload }); // Correct structure
    logger.debug(`${config.name} Emitted topic.seeded event for traceId ${traceId}`);
  } catch (error) {
    logger.error('Failed to emit topic.seeded event', { traceId, error: error instanceof Error ? error.message : String(error) });
    // Decide if we should return an error response here or let the workflow handle it
    return {
      status: 500,
      body: { error: 'Failed to initiate research workflow.' }
    };
  }

  // 4. Return the traceId to the client
  return {
    status: 200,
    body: { traceId: traceId },
  };
};
