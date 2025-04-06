import fetch from 'node-fetch';

// Configuration
const MOTIA_BASE_URL = process.env.MOTIA_URL || 'http://localhost:3000'; // Default, assumes Motia runs locally on port 3000
const SEED_TOPIC = process.argv[2] || "Quantum computing applications in drug discovery"; // Default topic or use CLI arg
const POLLING_DELAY_MS = 5000; // 5 seconds
const MAX_WAIT_TIME_MS = 90000; // 90 seconds max wait time

// Helper function for delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runTest() {
  console.log(`🧪 Starting E2E test for topic: "${SEED_TOPIC}"`);
  console.log(`🎯 Targeting Motia API at: ${MOTIA_BASE_URL}`);

  let traceId = null;

  // 1. Start the research workflow
  try {
    console.log("\n🚀 Step 1: Calling /start-research...");
    const startResponse = await fetch(`${MOTIA_BASE_URL}/start-research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed_topic: SEED_TOPIC }),
    });

    if (!startResponse.ok) {
      throw new Error(`Failed to start research: ${startResponse.status} ${startResponse.statusText}`);
    }

    const startResult = await startResponse.json();
    traceId = startResult.traceId;
    console.log(`✅ Workflow started successfully. Trace ID: ${traceId}`);

  } catch (error) {
    console.error(`❌ Error starting workflow: ${error.message}`);
    process.exit(1);
  }

  if (!traceId) {
    console.error("❌ Failed to get traceId. Aborting.");
    process.exit(1);
  }

  // 2. Poll for the report
  console.log(`\n⏱️ Step 2: Polling for report (up to ${MAX_WAIT_TIME_MS / 1000} seconds)...`);
  const startTime = Date.now();
  let report = null;
  let reportFetched = false;

  while (Date.now() - startTime < MAX_WAIT_TIME_MS) {
    try {
      // Poll using query parameter
      const reportUrl = `${MOTIA_BASE_URL}/api/reports?traceId=${traceId}`; // Query param URL
      // const reportUrl = `${MOTIA_BASE_URL}/api/reports/${traceId}`; // Revert to path param URL
      console.log(`   -> Checking ${reportUrl}`);

      const reportResponse = await fetch(reportUrl, { method: 'GET' });

      if (reportResponse.ok) {
        report = await reportResponse.json();
        console.log(`\n✅ Report found!`);
        reportFetched = true;
        break; // Exit loop once report is found
      } else if (reportResponse.status === 404) {
        // Report not ready yet, continue polling
        console.log(`   ... Report not ready (404), waiting ${POLLING_DELAY_MS / 1000}s`);
      } else {
        // Other error
        console.warn(`   ⚠️ Received unexpected status ${reportResponse.status} while polling.`);
      }
    } catch (error) {
      console.warn(`   ⚠️ Error during polling: ${error.message}`);
    }

    await delay(POLLING_DELAY_MS);
  }

  // 3. Log results
  console.log("\n📊 Step 3: Logging results...");
  if (reportFetched && report) {
    console.log("🎉 Test successful! Final Report:");
    console.log(JSON.stringify(report, null, 2));
    process.exit(0); // Success
  } else if (Date.now() - startTime >= MAX_WAIT_TIME_MS) {
    console.error(`❌ Test failed: Report not found within the timeout period (${MAX_WAIT_TIME_MS / 1000}s).`);
    process.exit(1); // Failure
  } else {
    console.error("❌ Test failed: Unknown reason (report not fetched).");
    process.exit(1); // Failure
  }
}

runTest().catch(err => {
  console.error("💥 Unhandled error during test execution:", err);
  process.exit(1);
});
