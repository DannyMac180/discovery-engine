import { StepHandler } from 'motia';

// Define the structure for evaluation criteria (matching report-compiler)
interface EvaluationCriterion {
  score: number;
  justification: string;
}

// Define the structure for an evaluated question (matching report-compiler)
interface EvaluatedQuestion {
  question: string;
  novelty: EvaluationCriterion;
  feasibility: EvaluationCriterion;
  impact: EvaluationCriterion;
  crossDisciplinary: EvaluationCriterion;
  overallScore: number;
  error?: string;
}

// Define the structure for the final report (matching report-compiler)
interface FinalReport {
  traceId: string;
  seedTopic: string | null;
  timestamp: string;
  topQuestions: EvaluatedQuestion[];
  metadata: {
    totalQuestionsEvaluated: number;
    questionsInReport: number;
  };
}

// Define the input type for the handler, expecting queryParams
interface ReportRetrieverInput {
  queryParams: {
    traceId?: string; // Expect optional traceId in query
  };
}

// Define context shape (can reuse ApiContext from research-starter or define specifically)
interface ApiContext {
  logger: any;
  state: {
    get: <T>(key: string) => Promise<T | undefined>; // Add type hint for get
  };
  request: any; // Add request property to ApiContext
}

// Define the step configuration for the API endpoint
export const config = {
  type: 'api' as const,
  method: 'GET' as const,
  path: '/api/reports', // Use query parameter for traceId
  name: 'report-retriever',
  description: 'Retrieves the final generated research report by its traceId (passed as query param).',
  emits: [] as string[],
  flows: ['the-discovery-engine'],
};

// The handler function for the API step
export const handler: StepHandler<typeof config> = async (input: ReportRetrieverInput, context: ApiContext) => {
  const { logger, state } = context;

  logger.debug('Report retriever API handler invoked');

  logger.debug('Attempting to retrieve report');

  // Read traceId from input
  const traceId = input.queryParams?.traceId; // Read from queryParams

  // Validate traceId (optional but good practice)
  if (typeof traceId !== 'string' || traceId.length === 0) {
    // Log the attempted traceId value before erroring
    logger.error('Invalid or missing traceId from input.queryParams', { 
      receivedQueryParams: input.queryParams 
    });
    // Restore original simple error response
    return { status: 400, body: { error: 'Valid traceId is required' }, headers: { 'Content-Type': 'application/json' } };
  }

  // Define default headers early
  const headers = { 'Content-Type': 'application/json' };

  logger.info(`[${traceId}] Received request for report.`);

  try {
    // Attempt to retrieve the compiled report from state
    const reportKey = `${traceId}:final_report`;
    logger.info(`Checking state for key: ${reportKey}`);
    const report = await state.get(reportKey);

    if (report) {
      logger.info(`[${traceId}] Found report in state. Returning report.`);
      // Return the report with a 200 OK status
      return { status: 200, headers, body: report };
    } else {
      logger.warn(`[${traceId}] Report not found in state for key: ${reportKey}.`);
      // Report not found, return 404
      return {
        status: 404,
        headers,
        body: { error: 'Report not found. It might still be processing or the traceId is invalid.' },
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[${traceId}] Error retrieving report from state: ${errorMessage}`);
    // Generic server error for state retrieval issues
    return {
      status: 500,
      headers, // Ensure headers are included in error response too
      body: { error: 'An internal server error occurred while retrieving the report.' },
    };
  }
};
