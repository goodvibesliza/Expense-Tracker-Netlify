// netlify/functions/webhook.js - Latest Version with Caption Processing
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
- Additional context: Include any additional context or notes provided in the workDescription field

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
      return null;
    }

    const data = await response.json();
    
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

// Process receipt with Google Vision OCR and save image
async function processReceiptOCR(imageBuffer, fileName) {
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
      return { text: null, imageUrl: null };
    }
    
    // Save image to Google Drive
    const imageUrl = await saveReceiptToGoogleDrive(buffer, fileName);
    
    // Return the full text detected and image URL
    const fullText = detections[0].description;
    console.log('OCR detected text:', fullText);
    console.log('Receipt saved to:', imageUrl);
    
    return { text: fullText, imageUrl };
    
  } catch (error) {
    console.error('OCR Error:', error);
    return { text: null, imageUrl: null };
  }
}

// Save receipt image to Google Drive
async function saveReceiptToGoogleDrive(imageBuffer, fileName) {
  try {
    const { google } = require('googleapis');
    
    // Create authentication
    const auth = new google.auth.JWT(
      GOOGLE_CREDENTIALS.client_email,
      null,
      GOOGLE_CREDENTIALS.private_key,
      ['https://www.googleapis.com/auth/drive.file']
    );
    
    const drive = google.drive({ version: 'v3', auth });
    
    // Create folder structure: Expense Receipts/YYYY/MM
    const currentDate = new Date();
    const year = currentDate.getFullYear();
    const month = String(currentDate.getMonth() + 1).padStart(2, '0');
    
    // Find or create main folder
    const mainFolderId = await findOrCreateFolder(drive, 'Expense Receipts', 'root');
    const yearFolderId = await findOrCreateFolder(drive, year.toString(), mainFolderId);
    const monthFolderId = await findOrCreateFolder(drive, `${year}-${month}`, yearFolderId);
    
    // Generate unique filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const uniqueFileName = `receipt-${timestamp}-${fileName}`;
    
    // Upload the image
    const fileMetadata = {
      name: uniqueFileName,
      parents: [monthFolderId]
    };
    
    const media = {
      mimeType: 'image/jpeg',
      body: require('stream').Readable.from(imageBuffer)
    };
    
    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id'
    });
    
    // Make file publicly viewable
    await drive.permissions.create({
      fileId: file.data.id,
      resource: {
        role: 'reader',
        type: 'anyone'
      }
    });
    
    // Return the public URL
    const publicUrl = `https://drive.google.com/file/d/${file.data.id}/view`;
    console.log('Receipt uploaded to Google Drive:', publicUrl);
    
    return publicUrl;
    
  } catch (error) {
    console.error('Error saving to Google Drive:', error);
    return null;
  }
}

// Helper function to find or create folders
async function findOrCreateFolder(drive, folderName, parentId) {
  try {
    // Search for existing folder
    const response = await drive.files.list({
      q: `name='${folderName}' and parents in '${parentId}' and mimeType='application/vnd.google-apps.folder'`,
      fields: 'files(id, name)'
    });
    
    if (response.data.files.length > 0) {
      return response.data.files[0].id;
    }
    
    // Create new folder
    const folderMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    };
    
    const folder = await drive.files.create({
      resource: folderMetadata,
      fields: 'id'
    });
    
    return folder.data.id;
    
  } catch (error) {
    console.error('Error with folder operations:', error);
    return parentId; // Fallback to parent
  }
}

// Get recent entries for editing
async function getRecentEntries(limit = 10) {
  try {
    const doc = await initGoogleSheet();
    let sheet = doc.sheetsByTitle['Sheet1'] || doc.sheetsByTitle['Master Sheet'];
    
    if (!sheet) {
      return [];
    }
    
    const rows = await sheet.getRows();
    const recentRows = rows.slice(-limit).reverse();
    
    return recentRows.map((row, index) => ({
      date: row.get('Date'),
      vendor: row.get('Vendor'),
      category: row.get('Category'),
      amount: row.get('Amount'),
      deductibilityPercentage: row.get('Deductible %'),
      description: row.get('Description')
    }));
  } catch (error) {
    console.error('Error getting recent entries:', error);
    return [];
  }
}

// Edit an entry
async function editEntry(entryNumber, field, newValue) {
  try {
    const doc = await initGoogleSheet();
    let sheet = doc.sheetsByTitle['Sheet1'] || doc.sheetsByTitle['Master Sheet'];
    
    if (!sheet) {
      return { success: false, error: 'Sheet not found' };
    }
    
    const rows = await sheet.getRows();
    
    if (entryNumber < 1 || entryNumber > rows.length) {
      return { success: false, error: `Entry #${entryNumber} not found. Use /recent to see available entries.` };
    }
    
    const row = rows[entryNumber - 1];
    
    if (field === 'description') {
      row.set('Description', newValue);
    } else if (field === 'notes') {
      const existingNotes = row.get('Work Description') || '';
      const updatedNotes = existingNotes ? `${existingNotes} | ${newValue}` : newValue;
      row.set('Work Description', updatedNotes);
    }
    
    await row.save();
    return { success: true };
  } catch (error) {
    console.error('Error editing entry:', error);
    return { success: false, error: error.message };
  }
}

// Add expense to Google Sheet
async function addExpenseToSheet(expenseData, sheetName = 'Sheet1') {
  try {
    const doc = await initGoogleSheet();
    
    let sheet = doc.sheetsByTitle[sheetName];
    
    if (!sheet) {
      sheet = doc.sheetsByTitle['Master Sheet'];
      if (!sheet) {
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
    
    console.log('Row data being added to sheet:', rowData);
    
    await sheet.addRow(rowData);
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
    const text = message.text || '';
    const photo = message.photo;
    
    console.log('Message received:', {
      hasText: !!message.text,
      textContent: message.text,
      hasPhoto: !!photo,
      hasCaption: !!message.caption,
      captionContent: message.caption
    });

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
        `🏢 <b>S-Corp Expense Tracker Ready!</b>\n\n` +
        `💰 <b>Add Expenses:</b>\n` +
        `• Text: "Client lunch $85"\n` +
        `• Photo: Send receipt images 📸\n\n` +
        `📊 <b>View & Edit:</b>\n` +
        `• /recent - View recent expenses\n` +
        `• /edit [#] [new description] - Edit entry\n` +
        `• /note [#] [additional notes] - Add notes\n` +
        `• /ytd - Year-to-date totals\n\n` +
        `I'll categorize everything for S-Corp tax rules!`
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

    if (text === '/recent') {
      const recentEntries = await getRecentEntries();
      if (recentEntries.length === 0) {
        await sendTelegramMessage(chatId, '📋 No recent entries found.');
      } else {
        let response = '📋 <b>Recent Expenses:</b>\n\n';
        recentEntries.forEach((entry, index) => {
          response += `<b>${index + 1}.</b> ${entry.date} - ${entry.vendor} - $${entry.amount}\n`;
          response += `   📂 ${entry.category} (${entry.deductibilityPercentage}% deductible)\n`;
          response += `   📝 ${entry.description}\n\n`;
        });
        response += `💡 Use /edit [#] or /note [#] to modify entries`;
        await sendTelegramMessage(chatId, response);
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'Recent entries sent' })
      };
    }

    // Handle edit commands
    if (text.startsWith('/edit ')) {
      const parts = text.split(' ');
      const entryNumber = parseInt(parts[1]);
      const newDescription = parts.slice(2).join(' ');
      
      if (!entryNumber || !newDescription) {
        await sendTelegramMessage(chatId, '❌ Usage: /edit [number] [new description]\nExample: /edit 3 Updated expense description');
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'Invalid edit command' }) };
      }

      const result = await editEntry(entryNumber, 'description', newDescription);
      if (result.success) {
        await sendTelegramMessage(chatId, `✅ Updated entry #${entryNumber} description`);
      } else {
        await sendTelegramMessage(chatId, `❌ ${result.error}`);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'Edit processed' }) };
    }

    // Handle note commands
    if (text.startsWith('/note ')) {
      const parts = text.split(' ');
      const entryNumber = parseInt(parts[1]);
      const additionalNotes = parts.slice(2).join(' ');
      
      if (!entryNumber || !additionalNotes) {
        await sendTelegramMessage(chatId, '❌ Usage: /note [number] [additional notes]\nExample: /note 3 This was for the client meeting');
        return { statusCode: 200, headers, body: JSON.stringify({ status: 'Invalid note command' }) };
      }

      const result = await editEntry(entryNumber, 'notes', additionalNotes);
      if (result.success) {
        await sendTelegramMessage(chatId, `✅ Added note to entry #${entryNumber}`);
      } else {
        await sendTelegramMessage(chatId, `❌ ${result.error}`);
      }
      return { statusCode: 200, headers, body: JSON.stringify({ status: 'Note processed' }) };
    }

    // Handle photo receipts
    if (photo && photo.length > 0) {
      const caption = message.caption || '';
      
      console.log('Processing photo with caption info:', {
        hasCaption: !!message.caption,
        captionText: message.caption,
        captionLength: message.caption ? message.caption.length : 0
      });
      
      await sendTelegramMessage(chatId, `📸 Processing your receipt${caption ? ' with notes' : ''}...`);
      
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
        
        // Process with Google Vision OCR and save image
        const fileName = `receipt-${largestPhoto.file_id}.jpg`;
        const ocrResult = await processReceiptOCR(imageBuffer, fileName);
        
        if (!ocrResult.text) {
          await sendTelegramMessage(chatId, '❌ Could not extract text from receipt. Please try a clearer photo or enter manually.');
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ status: 'OCR failed' })
          };
        }
        
        console.log('OCR extracted text:', ocrResult.text);
        console.log('Receipt image URL:', ocrResult.imageUrl);
        console.log('Caption provided:', caption);
        
        // Create the description for Claude - include caption in a clear way
        let descriptionForClaude = `Receipt text: ${ocrResult.text}`;
        if (caption && caption.trim().length > 0) {
          descriptionForClaude += `\n\nAdditional context: ${caption.trim()}`;
        }
        
        console.log('Combined text for Claude:', descriptionForClaude);
        
        // Process with Claude
        const expenseData = await processExpenseWithAI(descriptionForClaude);
        
        if (!expenseData) {
          await sendTelegramMessage(chatId, '❌ Could not categorize the receipt. Please try entering manually.');
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ status: 'Processing failed' })
          };
        }
        
        console.log('Receipt expense data processed:', expenseData);
        
        // If there was a caption, add it to the description
        if (caption && caption.trim().length > 0) {
          console.log('Adding caption to description:', caption);
          expenseData.suggestedDescription = `${expenseData.suggestedDescription} - ${caption.trim()}`;
          console.log('Updated description:', expenseData.suggestedDescription);
        } else {
          console.log('No caption to add or caption is empty');
        }
        
        // Add receipt image URL to work description
        if (ocrResult.imageUrl) {
          const receiptLink = `Receipt: ${ocrResult.imageUrl}`;
          expenseData.workDescription = expenseData.workDescription 
            ? `${expenseData.workDescription} | ${receiptLink}` 
            : receiptLink;
        }
        
        console.log('Final expense data being saved:', expenseData);
        
        const result = await addExpenseToSheet(expenseData);
        
        if (result.success) {
          let response = `📸 <b>Receipt Processed!</b>\n\n` +
            `💰 Amount: ${expenseData.amount}\n` +
            `🏪 Vendor: ${expenseData.vendor}\n` +
            `📂 Category: ${expenseData.category}\n` +
            `🏢 Entity: ${expenseData.entityType.toUpperCase()}\n` +
            `📊 Tax Deductible: ${expenseData.deductibilityPercentage}%\n` +
            `📝 Notes: ${expenseData.taxNotes}`;
          
          if (caption && caption.trim().length > 0) {
            response += `\n💬 Your notes: "${caption.trim()}" (added to description)`;
          }
          
          if (ocrResult.imageUrl) {
            response += `\n📎 Receipt stored: <a href="${ocrResult.imageUrl}">View Original</a>`;
          }
          
          response += `\n\n📋 Extracted: ${ocrResult.text.substring(0, 60)}...`;

          await sendTelegramMessage(chatId, response);
          console.log('Success message sent to Telegram');
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
        await sendTelegramMessage(chatId, `❌ Error processing receipt photo: ${error.message}`);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ status: 'Receipt processing error' })
        };
      }
    }

    // Handle regular text expenses (only if no photo was sent and not a command)
    if (text && typeof text === 'string' && !photo && !text.startsWith('/')) {
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

      const result = await addExpenseToSheet(expenseData);
      
      if (result.success) {
        let response = `✅ <b>Expense Added!</b>\n\n` +
          `💰 Amount: $${expenseData.amount}\n` +
          `🏪 Vendor: ${expenseData.vendor}\n` +
          `📂 Category: ${expenseData.category}\n` +
          `🏢 Entity: ${expenseData.entityType.toUpperCase()}\n` +
          `📊 Tax Deductible: ${expenseData.deductibilityPercentage}%\n` +
          `📝 Notes: ${expenseData.taxNotes}`;

        await sendTelegramMessage(chatId, response);
      } else {
        await sendTelegramMessage(chatId, `❌ Error saving expense: ${result.error}`);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'Processed successfully' })
      };
    }

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
