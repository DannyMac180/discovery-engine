import { StepHandler } from 'motia';
import OpenAI from 'openai';

// Define the expected input payload from the 'content.extracted' event
// We only really need the traceId, as we'll fetch the full content from state
interface ContentExtractedPayload {
  traceId: string;
  // extractedContent: ExtractedContent[]; // Included in payload, but we'll fetch from state for completeness
}

// Define the structure for extracted content (as stored in state)
interface ExtractedContent {
  url: string;
  title: string;
  content?: string;
  excerpt?: string;
  length?: number;
  error?: string;
}

// Define the expected context shape for this event step
interface CustomEventContext {
  logger: any; // Replace 'any' with specific Motia Logger type if known/available
  state: {
    get: <T>(key: string) => Promise<T | undefined>; // Add type hint for get
    set: (key: string, value: any) => Promise<void>;
  };
  event: {
    emit: (eventName: string, payload: any) => Promise<void>;
  };
  secrets: { [key: string]: string }; // Assuming secrets are key-value pairs
}

// Define the step configuration
export const config = {
  type: 'event',
  name: 'question-brainstormer',
  description: 'Analyzes extracted web content and seed topic to brainstorm research questions using OpenAI.',
  subscribes: ['exa.results.received'],
  emits: ['questions.generated'],
  flows: ['the-discovery-engine'],
};

// Helper function to truncate text
const truncateText = (text: string, maxLength: number): string => {
    if (!text) return '';
    return text.length > maxLength ? text.substring(0, maxLength) + '...' : text;
};

// The handler function for the event step
export const handler: StepHandler<typeof config> = async (payload: ContentExtractedPayload, context: CustomEventContext) => {
  const { logger, state, event, secrets } = context;
  const { traceId } = payload;

  logger.info(`[${traceId}] Received 'content.extracted' event. Starting question brainstorming.`);

  const apiKey = secrets.OPENAI_API_KEY;
  if (!apiKey) {
    logger.error(`[${traceId}] OpenAI API key is missing. Check environment variables and motia.config.ts secrets.`);
    await event.emit('workflow.error', { traceId, step: config.name, error: 'Missing OpenAI API Key' });
    return;
  }

  try {
    // 1. Retrieve necessary data from state
    const seedTopicKey = `${traceId}:seed_topic`;
    const contentKey = `${traceId}:extracted_content`;
    const [seedTopic, extractedContent] = await Promise.all([
      state.get<string>(seedTopicKey),
      state.get<ExtractedContent[]>(contentKey),
    ]);

    if (!seedTopic) {
      throw new Error(`Seed topic not found in state for key: ${seedTopicKey}`);
    }
    if (!extractedContent || extractedContent.length === 0) {
      // Decide how to handle: error out, or generate questions based only on seed topic?
      // For now, let's require some content.
      throw new Error(`Extracted content not found or empty in state for key: ${contentKey}`);
    }

    // 2. Prepare context for the LLM (limit size)
    // Combine titles and excerpts/truncated content from successful extractions
    const MAX_CONTEXT_CHARS = 8000; // Adjust based on model limits and desired prompt size
    let contextText = '';
    for (const item of extractedContent) {
      if (!item.error && (item.content || item.excerpt)) {
        const titlePart = item.title ? `Title: ${item.title}\n` : '';
        // Prefer excerpt, fallback to truncated content
        const contentPart = item.excerpt ? item.excerpt : truncateText(item.content || '', 300); // Truncate content snippet
        const entry = `${titlePart}Source: ${item.url}\nSummary: ${contentPart}\n---\n`;
        if (contextText.length + entry.length <= MAX_CONTEXT_CHARS) {
          contextText += entry;
        } else {
          break; // Stop adding more content if we exceed the limit
        }
      }
    }

    if (!contextText) {
      logger.warn(`[${traceId}] No usable content could be prepared for the LLM prompt.`);
      // Optional: proceed with just the seed topic, or emit an error?
      // Let's proceed with just the topic for now.
      contextText = "No content could be summarized from the provided sources.";
    }

    // 3. Design the Prompt
    const systemPrompt = `You are an expert research assistant specializing in identifying novel, impactful, and cross-disciplinary scientific research questions. Analyze the provided seed topic and context derived from web searches. Generate a list of 5-10 specific, actionable research questions that synthesize the information. Focus on questions that are not obvious and potentially bridge different fields. Output ONLY a valid JSON array of strings, where each string is a research question.`;

    const userPrompt = `Seed Topic: "${seedTopic}"

Context from Web Search Results:
${contextText}

Based on the seed topic and the context above, generate 5-10 novel, impactful, and potentially cross-disciplinary research questions. Return ONLY a valid JSON array of strings.`;

    // 4. Call OpenAI API
    logger.debug(`[${traceId}] Sending request to OpenAI for question brainstorming.`);
    const openai = new OpenAI({ apiKey });
    const chatCompletion = await openai.chat.completions.create({
      model: 'gpt-4.5-preview', // Or use a model from config/env if needed
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7, // Encourage some creativity
      response_format: { type: "json_object" }, // Request JSON output if model supports it
    });

    const responseContent = chatCompletion.choices[0]?.message?.content;
    if (!responseContent) {
      throw new Error('OpenAI response content was empty.');
    }

    // 5. Parse the response
    let generatedQuestions: string[] = [];
    try {
      // The response is expected to be a JSON object containing the array, e.g., { "questions": [...] }
      // Or potentially just the array string if the model doesn't wrap it.
      // Let's try parsing it flexibly.
      let parsedJson = JSON.parse(responseContent);

      // Look for a common key like 'questions' or assume the root is the array
      if (Array.isArray(parsedJson)) {
          generatedQuestions = parsedJson;
      } else if (parsedJson.questions && Array.isArray(parsedJson.questions)) {
          generatedQuestions = parsedJson.questions;
      } else {
          // Attempt to find the first array value in the object
          const arrayValue = Object.values(parsedJson).find(Array.isArray);
          if(arrayValue) {
              generatedQuestions = arrayValue as string[];
          } else {
              throw new Error('Could not find a JSON array of questions in the response.');
          }
      }

      // Filter out any non-string elements just in case
      generatedQuestions = generatedQuestions.filter(q => typeof q === 'string');

      if (generatedQuestions.length === 0) {
        throw new Error('OpenAI response parsed, but no questions found in the array.');
      }

      logger.info(`[${traceId}] Successfully generated ${generatedQuestions.length} research questions.`);

    } catch (parseError: unknown) {
      let errorMessage = 'Unknown parsing error';
      if (parseError instanceof Error) errorMessage = parseError.message;
      logger.error(`[${traceId}] Failed to parse JSON response from OpenAI: ${errorMessage}`);
      logger.debug(`[${traceId}] Raw OpenAI Response: ${responseContent}`);
      throw new Error(`Failed to parse OpenAI JSON response: ${errorMessage}`);
    }

    // 6. Store generated questions in state
    const questionsKey = `${traceId}:generated_questions`;
    await state.set(questionsKey, generatedQuestions);
    logger.debug(`[${traceId}] Stored generated questions in state at key: ${questionsKey}`);

    // 7. Emit the 'questions.generated' event
    await event.emit('questions.generated', {
      traceId: traceId,
      questions: generatedQuestions,
    });
    logger.info(`[${traceId}] Emitted 'questions.generated' event.`);

  } catch (error: unknown) {
    let errorMessage = 'Unknown error in question-brainstormer';
    if (error instanceof Error) errorMessage = error.message;
    logger.error(`[${traceId}] Error in question-brainstormer step: ${errorMessage}`);
    await event.emit('workflow.error', { traceId, step: config.name, error: errorMessage });
  }
};
