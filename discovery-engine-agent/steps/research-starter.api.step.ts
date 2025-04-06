import { StepHandler } from 'motia'; // Keep StepHandler for potential type info, but won't use directly in signature for now
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

// Define the expected context shape for an API step
interface ApiContext {
  logger: any; // Replace 'any' with specific Motia Logger type if known
  state: any;  // Replace 'any' with specific Motia State type if known
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

// The handler function for the API step - Use explicit types
export const handler = async (input: ResearchStarterInput, context: ApiContext) => {
  const { logger, state } = context;
  // Rely on motia's validation via bodySchema
  const body = input.body;

  logger.info(`Received request to start research for topic: "${body.seed_topic}"`);

  // 1. Generate a unique traceId
  const traceId = randomUUID();
  logger.debug(`Generated traceId: ${traceId}`);

  // 2. Store the seed topic in state using the traceId
  // Using traceId as a key scope for this workflow instance's state
  await state.set(`${traceId}:seed_topic`, body.seed_topic);
  logger.debug(`Stored seed topic "${body.seed_topic}" in state for traceId ${traceId}`);

  // 4. Return the traceId to the client
  return {
    status: 200,
    body: { traceId: traceId },
  };
};
