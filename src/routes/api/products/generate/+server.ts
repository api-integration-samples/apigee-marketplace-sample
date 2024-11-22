import type { DataProduct } from "$lib/interfaces";
import { json, type RequestHandler } from "@sveltejs/kit";
import { GoogleAuth } from "google-auth-library";
import { PUBLIC_PROJECT_ID, PUBLIC_API_HOST, PUBLIC_APIGEE_ENV } from '$env/static/public';
import { DataSourceTypes } from "$lib/utils";
import { VertexAI } from "@google-cloud/vertexai";

const auth = new GoogleAuth({
  scopes: 'https://www.googleapis.com/auth/cloud-platform'
});
const vertex_ai = new VertexAI({project: PUBLIC_PROJECT_ID, location: 'us-central1'});
const model = 'gemini-1.5-flash-002';
const generativeModel = vertex_ai.preview.getGenerativeModel({
  model: model,
  generationConfig: {
    'maxOutputTokens': 8192,
    'temperature': 1,
    'topP': 0.95,
  },
  safetySettings: [],
});

export const GET: RequestHandler = async ({ url }) => {

  const entity = url.searchParams.get('entity') ?? '';
  const type = url.searchParams.get('type') ?? '';
  let testPayload: any = {};
  if (type.startsWith("BigQuery")) {
    let response =  await fetch(`https://${PUBLIC_API_HOST}/v1/test/data/${entity}`);
    testPayload = await response.json();
  }
  else if (type === "API") {
    let response =  await fetch(`https://${PUBLIC_API_HOST}/v1/test/services/${entity}`);
    testPayload = await response.json();
  }
  else {
    let response =  await fetch(`https://${PUBLIC_API_HOST}/v1/test/mock/${entity}`);
    if (response.status === 200) {
      testPayload = await response.json();
    }
    else {
      console.error("Could not get mock data from Apigee - " + response.status);
    }
  }
  
  return json(testPayload);
};

export const POST: RequestHandler = async({ params, url, request}) => {

  let newProduct: DataProduct = await request.json();

  if (newProduct.protocols.includes("API") && (newProduct.source.startsWith("BigQuery") || newProduct.source === "API")) {
    // Set KVM entry for the data proxy to BigQuery
    await setKVMEntry("marketplace-kvm", newProduct.entity, newProduct.query);
  } else if (newProduct.source === DataSourceTypes.GenAITest) {
    let genAiResponse = await generatePayloadGemini(`Generate a sample JSON payload for ${newProduct.query} with at least 10 records and 20 properties per record. Only return pure JSON. `);
    genAiResponse = genAiResponse.replace("```json", "").replace("```", "").replaceAll("\n", "");
    await setKVMEntry("marketplace-kvm", newProduct.entity + "__mock", genAiResponse);
  }

	return json({
    result: "OK"
  });
}

async function setKVMEntry(KVMName: string, keyName: string, keyValue: string) {
  let token = await auth.getAccessToken();
  let response = await fetch(`https://apigee.googleapis.com/v1/organizations/${PUBLIC_PROJECT_ID}/environments/${PUBLIC_APIGEE_ENV}/keyvaluemaps/${KVMName}/entries`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: keyName,
      value: keyValue
    })
  });

  if (response.status === 409) {
    // Update KVM entry
    response = await fetch(`https://apigee.googleapis.com/v1/organizations/${PUBLIC_PROJECT_ID}/environments/${PUBLIC_APIGEE_ENV}/keyvaluemaps/${KVMName}/entries/${keyName}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: keyName,
        value: keyValue
      })
    });

    if (response.status != 200)
      console.error(response);
  }
  else {
    console.error(response);
  }
}

function generatePayloadGemini(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {

    const chat = generativeModel.startChat({});
    chat.sendMessageStream(prompt).then((chatResult) => {
      chatResult.response.then((streamResult) => {
        if (streamResult.candidates && streamResult.candidates.length > 0) {
          if (streamResult.candidates[0].content.parts[0].text)
            resolve(streamResult.candidates[0].content.parts[0].text);
        }
      });
    });
  });
}