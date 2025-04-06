// scripts/test-openai.js
import OpenAI from 'openai';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;

if (!apiKey) {
  console.error("Error: OPENAI_API_KEY is not set in the .env file.");
  process.exit(1);
}

console.log("🔑 Loaded API Key Prefix:", apiKey.substring(0, 10) + '...');

const openai = new OpenAI({
  apiKey: apiKey,
  timeout: 90 * 1000, // 90 seconds timeout (matching the agent step),
});

const topic = "Quantum computing applications in drug discovery"; // Same topic as e2e test
const prompt = `Given the research seed topic "${topic}", generate 3 to 5 diverse and specific search engine queries that would be effective for finding relevant scientific papers, articles, and datasets. Focus on different angles or sub-topics related to the seed topic. Output the queries as a JSON array of strings. Example format: ["query 1", "query 2", "query 3"]`;

const messages = [
  { role: 'system', content: 'You are an AI assistant specialized in generating effective search queries for scientific research.' },
  { role: 'user', content: prompt },
];

const requestPayload = {
  model: 'gpt-4o-mini',
  messages: messages,
  temperature: 0.7,
  max_tokens: 150,
  response_format: { type: "json_object" }, // Request JSON output
};

async function testOpenAI() {
  console.log("🧪 Starting OpenAI API test...");
  console.log("--- Request Payload ---");
  console.log(JSON.stringify(requestPayload, null, 2));
  console.log("-----------------------");
  console.log("\n🚀 Sending request to OpenAI (timeout: 90s)...");

  try {
    const startTime = Date.now();
    const response = await openai.chat.completions.create(requestPayload);
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000; // Duration in seconds

    console.log(`\n✅ Success! Received response in ${duration.toFixed(2)} seconds.`);
    console.log("--- OpenAI Response ---");
    console.log(JSON.stringify(response, null, 2));
    console.log("-----------------------");

    // Optional: Log just the generated content
    const content = response.choices[0]?.message?.content;
    if (content) {
      console.log("\n--- Generated Content ---");
      console.log(content);
      console.log("-----------------------");
    }

  } catch (error) {
    console.error("\n❌ Error calling OpenAI API:");
    console.error(error); // Log the full error object
  }
}

testOpenAI();
