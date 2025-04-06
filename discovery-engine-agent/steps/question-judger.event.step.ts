import { StepHandler } from 'motia';
import OpenAI from 'openai';

// Define the expected input payload from the 'questions.generated' event
interface QuestionsGeneratedPayload {
  traceId: string;
  questions: string[]; // The list of brainstormed questions
}

// Define the structure for evaluation criteria
interface EvaluationCriterion {
  score: number; // 1-10
  justification: string;
}

// Define the structure for a fully evaluated question
interface EvaluatedQuestion {
  question: string;
  novelty: EvaluationCriterion;
  feasibility: EvaluationCriterion;
  impact: EvaluationCriterion;
  crossDisciplinary: EvaluationCriterion;
  overallScore: number; // Calculated score, e.g., average
  error?: string; // Optional field for evaluation errors for this specific question
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
  name: 'question-judger',
  description: 'Evaluates brainstormed research questions based on predefined criteria using OpenAI.',
  subscribes: ['questions.generated'],
  emits: ['questions.judged'],
  flows: ['the-discovery-engine'],
};

// Helper function to delay execution
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// The handler function for the event step
export const handler: StepHandler<typeof config> = async (payload: QuestionsGeneratedPayload, context: CustomEventContext) => {
  const { logger, state, event, secrets } = context;

  logger.info(`[${payload.traceId}] Received 'questions.generated' event with ${payload.questions.length} questions. Starting evaluation.`);

  const apiKey = secrets.OPENAI_API_KEY;
  if (!apiKey) {
    logger.error(`[${payload.traceId}] OpenAI API key is missing. Cannot perform question evaluation.`);
    await event.emit('workflow.error', { traceId: payload.traceId, step: config.name, error: 'Missing OpenAI API Key' });
    return;
  }

  const openai = new OpenAI({ apiKey });
  const evaluatedQuestions: EvaluatedQuestion[] = [];

  try {
    // Retrieve the seed topic for context
    const seedTopicKey = `${payload.traceId}:seed_topic`;
    const seedTopic = await state.get<string>(seedTopicKey);
    if (!seedTopic) {
      logger.warn(`[${payload.traceId}] Seed topic not found in state (key: ${seedTopicKey}). Evaluation context will be limited.`);
      // Proceed without topic context, or throw error?
      // Let's proceed but the quality might be lower.
    }

    // Process each question individually for evaluation
    for (const question of payload.questions) {
      try {
        logger.debug(`[${payload.traceId}] Evaluating question: "${question}"`);

        // Design the evaluation prompt
        const systemPrompt = `You are an expert evaluator of scientific research questions. Analyze the given question based on the provided criteria. Respond ONLY with a valid JSON object containing keys: "novelty", "feasibility", "impact", and "crossDisciplinary". Each key should map to an object with "score" (an integer between 1 and 10) and "justification" (a brief string explaining the score).`;

        const userPrompt = `Evaluate the following research question:
"${question}"

${seedTopic ? `The original seed topic for context was: "${seedTopic}"` : 'No specific seed topic context available.'}

Provide scores (1-10) and brief justifications for each criterion:
- Novelty: How original and non-obvious is the question?
- Feasibility: How likely is it that this question can be realistically investigated with current/near-future methods and resources?
- Potential Impact: If answered, how significant could the impact be on its field or broader science/society?
- Cross-Disciplinary Potential: Does the question bridge different scientific fields or require interdisciplinary approaches?

Return ONLY the JSON object as described.`;

        // Call OpenAI API
        const chatCompletion = await openai.chat.completions.create({
          // Use a capable model. Consider fixing the model name from the previous step if it was incorrect ('o1')
          model: 'o1', // Or 'gpt-4-turbo' or the intended model
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.3, // Lower temperature for more deterministic evaluation
          response_format: { type: "json_object" },
        });

        const responseContent = chatCompletion.choices[0]?.message?.content;
        if (!responseContent) {
          throw new Error('OpenAI evaluation response content was empty.');
        }

        // Parse the JSON response
        let evaluationResult: Omit<EvaluatedQuestion, 'question' | 'overallScore' | 'error'>;
        try {
          evaluationResult = JSON.parse(responseContent);
          // Basic validation of the parsed structure
          if (!evaluationResult.novelty?.score || !evaluationResult.feasibility?.score || !evaluationResult.impact?.score || !evaluationResult.crossDisciplinary?.score) {
              throw new Error('Parsed JSON is missing required evaluation fields or scores.');
          }
        } catch (parseError: unknown) {
          let errorMessage = 'Unknown parsing error';
          if (parseError instanceof Error) errorMessage = parseError.message;
          logger.error(`[${payload.traceId}] Failed to parse JSON evaluation for question "${question}": ${errorMessage}`);
          logger.debug(`[${payload.traceId}] Raw OpenAI Response: ${responseContent}`);
          throw new Error(`Failed to parse OpenAI JSON evaluation: ${errorMessage}`);
        }

        // Calculate overall score (simple average for now)
        const overallScore = (evaluationResult.novelty.score +
                              evaluationResult.feasibility.score +
                              evaluationResult.impact.score +
                              evaluationResult.crossDisciplinary.score) / 4;

        evaluatedQuestions.push({
          question: question,
          ...evaluationResult,
          overallScore: parseFloat(overallScore.toFixed(2)), // Keep 2 decimal places
        });

        logger.debug(`[${payload.traceId}] Successfully evaluated question: "${question}" (Overall: ${overallScore.toFixed(2)})`);

        // Add a small delay to avoid hitting rate limits if evaluating many questions quickly
        await delay(500); // 500ms delay

      } catch (evalError: unknown) {
        let errorMessage = 'Unknown evaluation error';
        if (evalError instanceof Error) errorMessage = evalError.message;
        logger.error(`[${payload.traceId}] Failed to evaluate question "${question}": ${errorMessage}`);
        // Add the question with an error flag/message
        evaluatedQuestions.push({
          question: question,
          novelty: { score: 0, justification: 'Evaluation Error' },
          feasibility: { score: 0, justification: 'Evaluation Error' },
          impact: { score: 0, justification: 'Evaluation Error' },
          crossDisciplinary: { score: 0, justification: 'Evaluation Error' },
          overallScore: 0,
          error: errorMessage,
        });
      }
    }

    logger.info(`[${payload.traceId}] Finished evaluating ${evaluatedQuestions.length} questions. ${evaluatedQuestions.filter(q => q.error).length} failed.`);

    // Store the evaluated questions in state
    const evaluatedKey = `${payload.traceId}:evaluated_questions`;
    await state.set(evaluatedKey, evaluatedQuestions);
    logger.debug(`[${payload.traceId}] Stored evaluated questions in state at key: ${evaluatedKey}`);

    // Emit the 'questions.evaluated' event
    await event.emit('questions.judged', {
      traceId: payload.traceId,
      evaluatedQuestions: evaluatedQuestions,
    });
    logger.info(`[${payload.traceId}] Emitted 'questions.judged' event.`);

  } catch (error: unknown) {
    let errorMessage = 'Unknown critical error';
    if (error instanceof Error) errorMessage = error.message;
    logger.error(`[${payload.traceId}] Critical error during question evaluation process: ${errorMessage}`);
    await event.emit('workflow.error', { traceId: payload.traceId, step: config.name, error: `Critical error in evaluation step: ${errorMessage}` });
  }
};
