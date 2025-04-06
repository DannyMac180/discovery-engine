import { StepHandler } from 'motia';

// Define the structure for evaluation criteria (from previous step)
interface EvaluationCriterion {
  score: number;
  justification: string;
}

// Define the structure for a fully evaluated question (from previous step)
interface EvaluatedQuestion {
  question: string;
  novelty: EvaluationCriterion;
  feasibility: EvaluationCriterion;
  impact: EvaluationCriterion;
  crossDisciplinary: EvaluationCriterion;
  overallScore: number;
  error?: string;
}

// Define the expected input payload from the 'questions.evaluated' event
interface QuestionsEvaluatedPayload {
  traceId: string;
  evaluatedQuestions: EvaluatedQuestion[];
}

// Define the structure for the final report
interface FinalReport {
  traceId: string;
  seedTopic: string | null;
  timestamp: string;
  topQuestions: EvaluatedQuestion[];
  metadata: {
    totalQuestionsEvaluated: number;
    questionsInReport: number;
    // Could add more metadata like number of sources fetched/processed if stored
  };
}

// Define the step configuration
export const config = {
  type: 'event',
  name: 'report-compiler',
  description: 'Compiles the top-evaluated research questions into a final report.',
  subscribes: ['content.extracted', 'questions.judged'],
  emits: ['report.generated'],
  flows: ['the-discovery-engine'],
};

// The handler function for the event step
export const handler: StepHandler<typeof config> = async (payload, context) => {
  const { logger, state, event } = context;
  const { traceId, evaluatedQuestions } = payload as QuestionsEvaluatedPayload;
  const TOP_N_QUESTIONS = 5; // Number of top questions to include in the report

  logger.info(`[${traceId}] Received 'questions.evaluated' event with ${evaluatedQuestions.length} questions. Compiling report.`);

  try {
    // 1. Retrieve seed topic from state
    const seedTopicKey = `${traceId}:seed_topic`;
    const seedTopic = await state.get<string>(seedTopicKey);
    if (!seedTopic) {
      logger.warn(`[${traceId}] Seed topic not found in state (key: ${seedTopicKey}). Report will lack topic context.`);
    }

    // 2. Filter out questions that had evaluation errors and sort by score
    const validEvaluations = evaluatedQuestions.filter(q => !q.error);
    validEvaluations.sort((a, b) => b.overallScore - a.overallScore);

    // 3. Select top N questions
    const topQuestions = validEvaluations.slice(0, TOP_N_QUESTIONS);

    if (topQuestions.length === 0) {
      logger.warn(`[${traceId}] No valid questions available after evaluation to include in the report.`);
      // Optionally emit a specific event or error if no questions make it?
      // For now, we'll proceed but the report will be empty.
    }

    // 4. Create the structured report
    const finalReport: FinalReport = {
      traceId: traceId,
      seedTopic: seedTopic || 'Unknown' , // Use retrieved topic or fallback
      timestamp: new Date().toISOString(),
      topQuestions: topQuestions,
      metadata: {
        totalQuestionsEvaluated: evaluatedQuestions.length,
        questionsInReport: topQuestions.length,
        // TODO: Optionally retrieve and add counts from search_results or extracted_content state keys
      },
    };

    // 5. Store the final report in state
    const reportKey = `${traceId}:final_report`;
    await state.set(reportKey, finalReport);
    logger.debug(`[${traceId}] Stored final report in state at key: ${reportKey}`);

    // 6. Emit the 'report.ready' event
    await event.emit('report.generated', {
      traceId: traceId,
      report: finalReport,
    });
    logger.info(`[${traceId}] Emitted 'report.generated' event with top ${topQuestions.length} questions.`);

  } catch (error) {
    logger.error(`[${traceId}] Error compiling report: ${error.message}`);
    await event.emit('workflow.error', { traceId, step: config.name, error: `Error compiling report: ${error.message}` });
  }
};
