require('dotenv').config({ quiet: true });
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const GHL_HEADERS = {
  'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
  'Version': '2021-07-28',
  'Content-Type': 'application/json'
};

const STAGES = {
  CONSULTATION_SCHEDULED: '116e9c0d-38f0-431e-8b22-0557c1498c00',
  ATTORNEY_REVIEW: '72f638fb-b0bd-45e6-922b-ece5ddede796'
};

app.get('/', (req, res) => {
  res.json({ status: 'Conflict Check Service Running' });
});

app.post('/conflict-check', async (req, res) => {
  try {
    const data = req.body.customData || req.body;
    const { contact_id, opportunity_id, contact_name, opposing_party, related_parties } = data;
    const client_name = contact_name;
    console.log(`Conflict check for: ${client_name}`);
    console.log(`Opposing party: ${opposing_party}`);

    const priorContacts = await getPriorContacts();
    console.log(`Found ${priorContacts.length} GHL contacts`);

    const contactsList = formatContactsList(priorContacts);
    const conflictResult = await runConflictCheck(client_name, opposing_party, related_parties, contactsList);
    console.log(`Result: ${conflictResult.result}`);
    console.log(`Summary: ${conflictResult.summary}`);

    await updateGHL(contact_id, opportunity_id, conflictResult);
    console.log(`GHL updated successfully`);

    res.json({ success: true, result: conflictResult });

  } catch (error) {
    console.error('Error:', error.message);
    console.error('Detail:', JSON.stringify(error.response?.data));
    res.status(500).json({ success: false, error: error.message });
  }
});

async function getPriorContacts() {
  const response = await axios({
    method: 'get',
    url: `https://services.leadconnectorhq.com/contacts/?locationId=${process.env.GHL_LOCATION_ID}&limit=100`,
    headers: GHL_HEADERS
  });
  return response.data.contacts || [];
}

function formatContactsList(contacts) {
  if (!contacts.length) return 'No prior contacts on record.';
  return contacts.map((c, i) => {
    const name = `${c.firstName || ''} ${c.lastName || ''}`.trim();
    const tags = c.tags ? c.tags.join(', ') : '';
    const notes = c.notes || 'No notes';
    return `${i + 1}. ${name} | ${tags} | ${notes} | ${c.dateAdded}`;
  }).join('\n');
}

async function runConflictCheck(clientName, opposingParty, relatedParties, contactsList) {
  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: `You are a conflict check assistant for a law firm. Identify any potential conflict. Return valid JSON only with no markdown: {"result": "CONFLICT_FOUND or NO_CONFLICT", "match": "matching record name or null", "summary": "plain language explanation"}`,
      messages: [{ role: 'user', content: `New client: ${clientName}\nOpposing party: ${opposingParty}\nRelated parties: ${relatedParties || 'None'}\n\nPrior contacts:\n${contactsList}` }]
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    }
  );

  const text = response.data.content[0].text;
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

async function updateGHL(contactId, opportunityId, conflictResult) {
  const isConflict = conflictResult.result === 'CONFLICT_FOUND';

  // Update Contact tags
  await axios({
    method: 'put',
    url: `https://services.leadconnectorhq.com/contacts/${contactId}`,
    headers: GHL_HEADERS,
    data: {
      tags: isConflict
        ? ['prior-consult', 'conflict-check-CONFLICT']
        : ['prior-consult', 'conflict-check-clear']
    }
  });
  console.log('Contact tags updated');

  // Update Opportunity custom fields + stage
await axios({
  method: 'put',
  url: `https://services.leadconnectorhq.com/opportunities/${opportunityId}`,
  headers: GHL_HEADERS,
  data: {
    pipelineStageId: isConflict ? STAGES.ATTORNEY_REVIEW : STAGES.CONSULTATION_SCHEDULED,
    customFields: [
      { key: 'conflict_check_status', field_value: isConflict ? 'Conflict Found' : 'Clear' },
      { key: 'conflict_check_summary', field_value: conflictResult.summary },
      { key: 'conflict_check_date', field_value: new Date().toISOString() }
    ]
  }
});
  console.log(`Opportunity moved to: ${isConflict ? 'Attorney Review' : 'Consultation Scheduled'}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Conflict Check Service running on port ${PORT}`));
