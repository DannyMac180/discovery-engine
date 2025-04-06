const config = {
  // Specify the path to the state file relative to the project root
  state: {
    filePath: './.motia/motia.state.json',
  },
  // Basic event bus configuration (defaults are often sufficient)
  eventBus: {},
  // Specify where Motia step files are located
  // Adjust this path if your steps are elsewhere
  stepsPath: './steps',
  // Placeholder for secrets - load sensitive keys from environment variables
  secrets: {
    // Example structure - keys defined here can be accessed in steps via context.secrets
    // Ensure corresponding variables (e.g., OPENAI_API_KEY) are set in your .env file
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    // ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    EXA_API_KEY: process.env.EXA_API_KEY, // Added for Exa Search
  },
};

export default config;
