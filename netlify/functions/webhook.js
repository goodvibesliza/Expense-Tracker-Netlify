// netlify/functions/webhook.js - Netlify Function
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// Environment Variables
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const AUTHORIZED_CHAT_IDS = process.env.AUTHORIZED_CHAT_IDS?.split(',') || [];
const SHEET_ID = process.env.SHEET_ID;

const GOOGLE_CREDENTIALS = {
  client_email: process.env.GOOGLE_CLIENT_EMAIL,
  private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
};

const STANDARD_DEDUCTION_2025 = 14600;

// Initialize Google Sheets
async function initGoogleSheet() {
  const serviceAccountAuth = new JWT({
    email: GOOGLE_CREDENTIALS.client_email,
    key: GOOGLE_CREDENTIALS.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
  await doc.loadInfo();
  return doc;
}

// Process expense with Claude AI
async function processExpenseWithAI(description) {
  const prompt = `
You are an AI assistant specialized in S-Corp and Family LLC expense categorization for US tax purposes.

Analyze this expense description and respond with ONLY a valid JSON object in this exact format:
{
  "amount": number,
  "vendor": "string",
  "category": "string",
  "businessType": "business" or "personal" or "family_llc",
  "entityType": "scorp" or "family_llc",
  "taxDeductible": true or false,
  "deductibilityPercentage": number (0-100),
  "taxNotes": "string explaining deductibility rules",
  "suggestedDescription": "cleaned up description",
  "workDescription": "if applicable, brief work description for family LLC payments"
}

Business Entity Rules:
S-Corp Tax Categories:
- Business Meals: 50% deductible (business-related only)
- Office Supplies: 100% deductible
- Professional Services: 100% deductible (including Family LLC management fees)
- Travel Expenses: 100% deductible (business travel)
- Equipment/Software: 100% deductible
- Marketing/Advertising: 100% deductible
- Training/Education: 100% deductible
- Vehicle Expenses: 100% deductible (verify business use)
- Personal Expenses: 0% deductible

Family LLC Categories:
- Contract Labor: 100% deductible (payments to son for work)
- Management Services: 100% deductible (from S-Corp)
- Equipment/Supplies: 100% deductible
- Professional Services: 100% deductible

Special Cases:
- "Family LLC management fee" or "$1100 management" = Professional Services to Family LLC
- Payments to son for video editing, maintenance = Contract Labor from Family LLC
- Venmo payments to son = Contract Labor from Family LLC
- Rental cars, travel = Travel Expenses, 100% deductible
- Receipt text: Extract vendor, amount, and categorize based on the receipt content

Expense Description: "${description}"

Your entire response MUST ONLY be a single, valid JSON object. DO NOT include backticks or markdown formatting.
`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      console.error('Claude API error:', response.status, response.statusText);
      const errorText = await response.text();
      console.error('Error details:', errorText);
      return null;
    }

    const data = await response.json();
    
    console.log('Claude API response:', JSON.stringify(data, null, 2));
    
    if (!data.content || !data.content[0] || !data.content[0].text) {
      console.error('Unexpected Claude API response structure:', data);
      return null;
    }
    
    let responseText = data.content[0].text;
    responseText = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    
    return JSON.parse(responseText);
  } catch (error) {
    console.error('Error processing with Claude:', error);
    return null;
  }
}

// Add expense to Google Sheet
async function addExpenseToSheet(expenseData, sheetName = 'Master Sheet') {
  try {
    console.log(`Attempting to add expense to sheet: ${sheetName}`);
    const doc = await initGoogleSheet();
    
    console.log('Available sheets:', Object.keys(doc.sheetsByTitle));
    
    const sheet = doc.sheetsByTitle[sheetName];
    
    if (!sheet) {
      console.error(`Sheet "${sheetName}" not found. Available sheets:`, Object.keys(doc.sheetsByTitle));
      // Try "Sheet1" as fallback
      const fallbackSheet = doc.sheetsByTitle['Sheet1'];
      if (fallbackSheet) {
        console.log('Using Sheet1 as fallback');
        const sheet = fallbackSheet;
      } else {
        return { success: false, error: `Sheet "${sheetName}" not found` };
      }
    }

    const today = new Date().toISOString().split('T')[0];
    
    const rowData = {
      'Date': today,
      'Vendor': expenseData.vendor,
      'Category': expenseData.category,
      'Amount': expenseData.amount,
      'Business Type': expenseData.businessType,
      'Entity': expenseData.entityType,
      'Deductible %': expenseData.deductibilityPercentage,
      'Tax Notes': expenseData.taxNotes,
      'Description': expenseData.suggestedDescription,
      'Work Description': expenseData.workDescription || ''
    };
    
    console.log('Adding row data:', rowData);
    
    await sheet.addRow(rowData);
    console.log('Successfully added row to sheet');

    // If it's a Family LLC expense, also add to Family LLC sheet and check YTD
    if (expenseData.entityType === 'family_llc' && expenseData.businessType !== 'personal') {
      try {
        await addExpenseToSheet(expenseData, 'Family LLC');
        
        if (expenseData.category === 'Contract Labor') {
          const ytdTotal = await calculateYTDPayments();
          return { success: true, ytdTotal };
        }
      } catch (familyLLCError) {
        console.log('Could not add to Family LLC sheet (might not exist):', familyLLCError.message);
      }
    }

    return { success: true };
  } catch (error) {
    console.error('Error adding to sheet:', error);
    return { success: false, error: error.message };
  }
}

// Calculate YTD payments to son
async function calculateYTDPayments() {
  try {
    const doc = await initGoogleSheet();
    const sheet = doc.sheetsByTitle['Family LLC'];
    
    if (!sheet) {
      console.log('Family LLC sheet not found, returning 0');
      return 0;
    }
    
    const rows = await sheet.getRows();
    
    const currentYear = new Date().getFullYear();
    let ytdTotal = 0;
    
    rows.forEach(row => {
      const rowYear = new Date(row.get('Date')).getFullYear();
      if (rowYear === currentYear && row.get('Category') === 'Contract Labor') {
        ytdTotal += parseFloat(row.get('Amount')) || 0;
      }
    });
    
    return ytdTotal;
  } catch (error) {
    console.error('Error calculating YTD:', error);
    return 0;
  }
}

// Process receipt with Google Vision OCR
async function processReceiptOCR(imageBuffer) {
  try {
    // Use Google Vision API for OCR
    const vision = require('@google-cloud/vision');
    
    // Create a client using the same credentials as Google Sheets
    const client = new vision.ImageAnnotatorClient({
      credentials: {
        client_email: GOOGLE_CREDENTIALS.client_email,
        private_key: GOOGLE_CREDENTIALS.private_key
      }
    });
    
    // Convert ArrayBuffer to Buffer
    const buffer = Buffer.from(imageBuffer);
    
    // Perform text detection on the image
    const [result] = await client.textDetection({
      image: { content: buffer }
    });
    
    const detections = result.textAnnotations;
    
    if (!detections || detections.length === 0) {
      console.log('No text detected in image');
      return null;
    }
    
    // Return the full text detected
    const fullText = detections[0].description;
    console.log('OCR detected text:', fullText);
    
    return fullText;
    
  } catch (error) {
    console.error('OCR Error:', error);
    return null;
  }
}

// Send message to Telegram
async function sendTelegramMessage(chatId, message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (error) {
    console.error('Error sending Telegram message:', error);
  }
}

// Main Netlify handler
exports.handler = async (event, context) => {
  console.log('Webhook called with method:', event.httpMethod);
  
  // Handle CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers };
  }

  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: 'S-Corp Expense Tracker is running on Netlify! 🚀',
        timestamp: new Date().toISOString(),
        envCheck: {
          hasTelegramToken: !!TELEGRAM_TOKEN,
          hasClaudeKey: !!CLAUDE_API_KEY,
          hasSheetId: !!SHEET_ID,
          hasGoogleEmail: !!GOOGLE_CREDENTIALS.client_email,
          hasGoogleKey: !!GOOGLE_CREDENTIALS.private_key,
          authorizedUsers: AUTHORIZED_CHAT_IDS.length
        }
      })
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const body = JSON.parse(event.body);
    const { message } = body;
    
    if (!message || (!message.text && !message.photo)) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'No message text or photo' })
      };
    }

    const chatId = message.chat.id.toString();
    const text = message.text;
    const photo = message.photo;

    if (!AUTHORIZED_CHAT_IDS.includes(chatId)) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'Unauthorized' })
      };
    }

    // Handle commands
    if (text === '/start') {
      await sendTelegramMessage(chatId, 
        `🏢 <b>S-Corp Expense Tracker Ready on Netlify!</b>\n\n` +
        `Send me expense descriptions like:\n` +
        `• "Client lunch at Morton's $85"\n` +
        `• "Family LLC management fee $1100"\n` +
        `• "Paid son for video editing $200"\n` +
        `• "Office supplies at Staples $45"\n` +
        `• "Rental car for business trip $353"\n\n` +
        `I'll categorize them for S-Corp tax rules and track Family LLC payments!`
      );
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'Start message sent' })
      };
    }

    if (text === '/ytd') {
      const ytdTotal = await calculateYTDPayments();
      const remaining = STANDARD_DEDUCTION_2025 - ytdTotal;
      await sendTelegramMessage(chatId,
        `💰 <b>Son's YTD Payments:</b>\n` +
        `Paid: $${ytdTotal.toFixed(2)}\n` +
        `Remaining under std deduction: $${remaining.toFixed(2)}\n` +
        `Standard deduction limit: $${STANDARD_DEDUCTION_2025}`
      );
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'YTD message sent' })
      };
    }

    // Handle photo receipts
    if (photo && photo.length > 0) {
      await sendTelegramMessage(chatId, '📸 Processing your receipt...');
      
      try {
        // Get the largest photo
        const largestPhoto = photo[photo.length - 1];
        
        // Download photo from Telegram
        const fileResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${largestPhoto.file_id}`);
        const fileData = await fileResponse.json();
        
        if (!fileData.ok) {
          throw new Error('Could not get file info from Telegram');
        }
        
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileData.result.file_path}`;
        const imageResponse = await fetch(fileUrl);
        const imageBuffer = await imageResponse.arrayBuffer();
        
        // Process with Google Vision OCR
        const ocrText = await processReceiptOCR(imageBuffer);
        
        if (!ocrText) {
          await sendTelegramMessage(chatId, '❌ Could not extract text from receipt. Please try a clearer photo or enter manually.');
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ status: 'OCR failed' })
          };
        }
        
        console.log('OCR extracted text:', ocrText);
        
        // Process the extracted text with Claude
        const expenseData = await processExpenseWithAI(`Receipt text: ${ocrText}`);
        
        if (!expenseData) {
          await sendTelegramMessage(chatId, '❌ Could not categorize the receipt. Please try entering manually.');
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ status: 'Processing failed' })
          };
        }
        
        console.log('Receipt expense data processed:', expenseData);
        
        const result = await addExpenseToSheet(expenseData);
        
        if (result.success) {
          let response = `📸 <b>Receipt Processed!</b>\n\n` +
            `💰 Amount: ${expenseData.amount}\n` +
            `🏪 Vendor: ${expenseData.vendor}\n` +
            `📂 Category: ${expenseData.category}\n` +
            `🏢 Entity: ${expenseData.entityType.toUpperCase()}\n` +
            `📊 Tax Deductible: ${expenseData.deductibilityPercentage}%\n` +
            `📝 Notes: ${expenseData.taxNotes}\n\n` +
            `📋 Extracted: ${ocrText.substring(0, 100)}...`;

          await sendTelegramMessage(chatId, response);
        } else {
          await sendTelegramMessage(chatId, `❌ Error saving receipt: ${result.error}`);
        }
        
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ status: 'Receipt processed successfully' })
        };
        
      } catch (error) {
        console.error('Error processing receipt:', error);
        await sendTelegramMessage(chatId, '❌ Error processing receipt photo. Please try again.');
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ status: 'Receipt processing error' })
        };
      }
    }

    // Handle text expenses (only if no photo was sent)
    if (text && !photo) {
      // Process text expense
      console.log('Processing text expense:', text);
      await sendTelegramMessage(chatId, '🤖 Processing your expense...');
    await sendTelegramMessage(chatId, '🤖 Processing your expense...');
    
    const expenseData = await processExpenseWithAI(text);
    
    if (!expenseData) {
      await sendTelegramMessage(chatId, '❌ Sorry, I couldn\'t process that expense. Please try again.');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'Processing failed' })
      };
    }

    console.log('Expense data processed:', expenseData);
    
    const result = await addExpenseToSheet(expenseData);
    
    if (result.success) {
      let response = `✅ <b>Expense Added!</b>\n\n` +
        `💰 Amount: $${expenseData.amount}\n` +
        `🏪 Vendor: ${expenseData.vendor}\n` +
        `📂 Category: ${expenseData.category}\n` +
        `🏢 Entity: ${expenseData.entityType.toUpperCase()}\n` +
        `📊 Tax Deductible: ${expenseData.deductibilityPercentage}%\n` +
        `📝 Notes: ${expenseData.taxNotes}`;

      if (result.ytdTotal !== undefined) {
        const remaining = STANDARD_DEDUCTION_2025 - result.ytdTotal;
        response += `\n\n💡 <b>Son's YTD Total:</b> $${result.ytdTotal.toFixed(2)}\n`;
        response += `Remaining: $${remaining.toFixed(2)}`;
        
        if (remaining < 1000) {
          response += `\n⚠️ <b>Alert:</b> Approaching standard deduction limit!`;
        }
      }

      await sendTelegramMessage(chatId, response);
    } else {
      await sendTelegramMessage(chatId, `❌ Error saving expense: ${result.error}`);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ status: 'Processed successfully' })
    };
    } // End of text processing

    // If we get here, it's neither a command, photo, nor text
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ status: 'No processable content' })
    };
  } catch (error) {
    console.error('Webhook error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
