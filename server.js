// server.js - WhatsCRM Webhook Server v2.0
require('dotenv').config();

// Imports - defined only once
let express, createClient, axios, Anthropic, fs, path;
if (!express) express = require('express');
if (!createClient) ({ createClient } = require('@supabase/supabase-js'));
if (!axios) axios = require('axios');
if (!Anthropic) Anthropic = require('@anthropic-ai/sdk');
if (!fs) fs = require('fs');
if (!path) path = require('path');

const app = express();
app.use(express.json());

// ========================================
// 🔌 חיבורים
// ========================================

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Claude AI
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ========================================
// 🎯 מילות מפתח לזיהוי פניות עסקיות
// ========================================
const BUSINESS_KEYWORDS = {
  he: [
    'בעיה', 'תקלה', 'תיקון', 'שירות', 'מחיר', 'הצעת מחיר', 'עלות', 'תריס', 'חלון', 'מידרג',
    'מדרג', 'חנייה', 'ויטרינה', 'שער', 'שלט', 'לחצן', 'פתיחה', 'סגירה',
    'תקוע', 'שבור', 'לא עובד', 'לא פותח', 'לא סגר', 'תקלה טכנית',
    'צריך עזרה', 'דחוף', 'מתי', 'כמה עולה', 'מומחה', 'טכנאי',
    'מקולקל', 'פגום', 'צריך תיקון', 'דליפה', 'חשמל', 'חיווט',
    'שיפוץ', 'שדרוג', 'אחזקה', 'ביקורת', 'בדיקה', 'תחזוקה'
  ],
  en: [
    'problem', 'issue', 'repair', 'service', 'price', 'quote', 'cost',
    'Window', 'garage', 'midrag', 'shutter', 'sign', 'button', 'broken',
    'not working', 'stuck', 'help', 'urgent', 'technician', 'fix'
  ],
  ru: [
    'проблема', 'ремонт', 'сервис', 'цена', 'стоимость', 'парковка',
    'барьер', 'ворота', 'сломан', 'не работает', 'помощь'
  ]
};

// מילות מפתח שמעידות על שיחה פרטית (לא עסקית)
const PRIVATE_KEYWORDS = {
  he: [
    'איך אתה', 'מה שלומך', 'מה נשמע', 'בוקר טוב', 'לילה טוב',
    'שבת שלום', 'חג שמח', 'מזל טוב', 'תודה רבה', 'תודה על',
    'מה קורה', 'איך היה', 'שמעתי ש', 'ראיתי ש', 'אהבתי',
    'משעמם', 'נדבר מחר', 'נתראה', 'להתראות'
  ],
  en: [
    'how are you', 'what\'s up', 'good morning', 'good night',
    'thanks', 'thank you', 'see you', 'bye', 'talk later'
  ]
};

// ========================================
// 📞 פונקציה לנרמול מספרי טלפון
// ========================================
function normalizePhone(phone) {
  if (!phone) return null;
  
  // הסר כל מה שלא ספרות
  let cleaned = phone.replace(/[^\d]/g, '');
  
  // אם מתחיל ב-0 - החלף ל-972
  if (cleaned.startsWith('0')) {
    cleaned = '972' + cleaned.substring(1);
  }
  
  // אם לא מתחיל ב-972 - הוסף
  if (!cleaned.startsWith('972')) {
    cleaned = '972' + cleaned;
  }
  
  return cleaned;
}


async function analyzeMessageWithClaude(message, conversationHistory = [], customerInfo = null) {
  try {
    // בנה context של הלקוח אם יש
    let customerContext = '';
    if (customerInfo) {
      customerContext = `\n\nפרטי הלקוח הקיימים:`;
      if (customerInfo.name && !customerInfo.name.startsWith('לקוח')) {
        customerContext += `\n- שם: ${customerInfo.name}`;
      }
      if (customerInfo.address) {
        customerContext += `\n- כתובת: ${customerInfo.address}`;
      }
      if (customerInfo.city) {
        customerContext += `\n- עיר: ${customerInfo.city}`;
      }
      customerContext += `\n\n⚠️ חשוב: אל תבקש שוב פרטים שכבר קיימים!`;
    }
    
    const prompt = `אתה עוזר חכם לעסק תיקונים. 
נתחיל שיחה עם לקוח שכתב את ההודעה הבאה:

"${message}"

${conversationHistory.length > 0 ? `הקשר של השיחה הקודמת:\n${conversationHistory.map(h => `- ${h}`).join('\n')}` : ''}

${customerContext}

**חשוב מאוד:**
1. אם השם כבר קיים בפרטי הלקוח - אל תבקש אותו שוב!
2. אם הכתובת כבר קיימת - אל תבקש אותה שוב!
3. תן תשובה שמתחשבת בהקשר המלא של השיחה
4. אם הלקוח דיבר על תריס/חלון/שער - אל תחליף את זה ל"חניון"
5. השתמש במידע הקיים והתמקד במה שחסר

נתח את ההודעה והחזר JSON בפורמט הבא בדיוק:
{
  "is_business_inquiry": true/false,
  "intent": "problem_report" | "quote_request" | "question" | "appointment" | "approval" | "greeting" | "other",
  "urgency": "high" | "medium" | "low",
  "sentiment": "positive" | "neutral" | "negative",
  "requires_media": true/false,
  "needs_address": true/false,
  "suggested_products": ["product1", "product2"],
  "summary": "תקציר קצר של הפנייה - תוך שימוש בהקשר המלא!",
  "suggested_response": "תשובה מותאמת ללקוח - אל תבקש פרטים שכבר קיימים!"
}

כללים:
1. is_business_inquiry = true רק אם זו באמת פנייה עסקית
2. needs_address = true רק אם הכתובת חסרה
3. אם יש שם וכתובת - suggested_response צריך להודות על הפרטים ולהתמקד בבעיה
4. התשובה חייבת להיות JSON תקין בלבד`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const analysisText = response.content[0].text.trim();
    const cleanedText = analysisText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const analysis = JSON.parse(cleanedText);
    
    console.log('🧠 Claude AI Analysis:', JSON.stringify(analysis, null, 2));
    return analysis;

  } catch (error) {
    console.error('❌ שגיאה בניתוח Claude:', error.message);
    
    return {
      is_business_inquiry: detectBusinessInquiry(message),
      intent: 'other',
      urgency: 'medium',
      sentiment: 'neutral',
      requires_media: false,
      suggested_products: [],
      summary: message.substring(0, 100),
      suggested_response: 'תודה על הפנייה! נחזור אליך בהקדם.'
    };
  }
}

// ========================================
// 🔍 זיהוי פנייה עסקית (Fallback)
// ========================================
function detectBusinessInquiry(message) {
  const lowerMessage = message.toLowerCase();
  
  // בדוק מילות מפתח פרטיות - אם יש, זו לא פנייה עסקית
  const hasPrivateKeywords = PRIVATE_KEYWORDS.he.some(keyword => 
    lowerMessage.includes(keyword.toLowerCase())
  );
  
  if (hasPrivateKeywords) {
    console.log('🚫 זוהתה שיחה פרטית - לא פנייה עסקית');
    return false;
  }
  
  // בדוק מילות מפתח עסקיות
  const hasBusinessKeywords = BUSINESS_KEYWORDS.he.some(keyword => 
    lowerMessage.includes(keyword.toLowerCase())
  );
  
  // אם ההודעה ארוכה יותר מ-20 תווים ויש בה מילות מפתח - ככל הנראה עסקית
  if (message.length > 20 && hasBusinessKeywords) {
    console.log('✅ זוהתה פנייה עסקית');
    return true;
  }
  
  // אם ההודעה קצרה מדי או אין מילות מפתח - לא עסקית
  console.log('⚠️ לא ברור אם פנייה עסקית - מסומן כלא עסקי');
  return false;
}

// ========================================
// 💬 יצירת הודעת קבלה מותאמת אישית
// ========================================
function generateWelcomeMessage(business, analysis) {
  // אם זו לא פנייה עסקית - תשובה מינימלית
  if (!analysis.is_business_inquiry) {
    return 'שלום! 👋';
  }
  
  // אם יש תשובה מוצעת מ-Claude - השתמש בה
  if (analysis.suggested_response) {
    return analysis.suggested_response;
  }
  
  // תבנית ברירת מחדל
  return `שלום! אני ${business.owner_name} מ-${business.business_name} 👋

קיבלתי את הפנייה שלך! 

${analysis.requires_media ? 'האם תוכל לשלוח תמונה או וידאו של הבעיה כדי שאוכל להכין הצעת מחיר מדויקת?' : 'אחזור אליך בהקדם עם הצעת מחיר.'}`;
}

// ========================================
// 📸 שמירת מדיה (תמונות/וידאו)
// ========================================
async function saveMedia(leadId, mediaUrl, mediaType, caption) {
  try {
    console.log(`💾 שומר מדיה: ${mediaType} - ${mediaUrl}`);
    
    // הורד את הקובץ
    const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(response.data);
    const fileExtension = getFileExtension(mediaType, mediaUrl);
    const fileName = `lead_${leadId}_${Date.now()}.${fileExtension}`;
    
    // העלה ל-Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase.storage
      .from('lead-photos')
      .upload(fileName, buffer, {
        contentType: response.headers['content-type'] || getContentType(mediaType),
        cacheControl: '2592000', // 30 days
      });
    
    if (uploadError) {
      console.error('❌ שגיאה בהעלאת קובץ:', uploadError);
      return null;
    }
    
    // שמור מטא-דאטה בטבלה
    const { data: mediaData, error: dbError } = await supabase
      .from('lead_media')
      .insert({
        lead_id: leadId,
        media_type: mediaType,
        file_path: uploadData.path,
        caption: caption,
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
      })
      .select()
      .single();
    
    if (dbError) {
      console.error('❌ שגיאה בשמירת מטא-דאטה:', dbError);
      return null;
    }
    
    console.log('✅ מדיה נשמרה בהצלחה!');
    return mediaData;
    
  } catch (error) {
    console.error('❌ שגיאה בשמירת מדיה:', error.message);
    return null;
  }
}

function getFileExtension(mediaType, url) {
  const typeMap = {
    'image': 'jpg',
    'video': 'mp4',
    'document': 'pdf',
    'audio': 'opus'  // WhatsApp משתמש ב-opus להודעות קוליות
  };
  
  // נסה לחלץ מה-URL
  const match = url.match(/\.([a-z0-9]+)(?:[?#]|$)/i);
  if (match) return match[1];
  
  return typeMap[mediaType] || 'bin';
}

function getContentType(mediaType) {
  const typeMap = {
    'image': 'image/jpeg',
    'video': 'video/mp4',
    'document': 'application/pdf',
    'audio': 'audio/ogg'  // או audio/opus
  };
  return typeMap[mediaType] || 'application/octet-stream';
}

// ========================================
// 🗑️ מחיקת מדיה ישנה (Job לרוץ יומי)
// ========================================
async function cleanupExpiredMedia() {
  try {
    console.log('🧹 מנקה מדיה שפג תוקפה...');
    
    // מצא קבצים שפג תוקפם
    const { data: expiredMedia, error: fetchError } = await supabase
      .from('lead_media')
      .select('*')
      .lt('expires_at', new Date().toISOString());
    
    if (fetchError) {
      console.error('❌ שגיאה בשליפת מדיה:', fetchError);
      return;
    }
    
    if (!expiredMedia || expiredMedia.length === 0) {
      console.log('✅ אין מדיה פג תוקף');
      return;
    }
    
    console.log(`🗑️ נמצאו ${expiredMedia.length} קבצים למחיקה`);
    
    // מחק כל קובץ
    for (const media of expiredMedia) {
      // מחק מ-Storage
      const { error: deleteError } = await supabase.storage
        .from('lead-photos')
        .remove([media.file_path]);
      
      if (deleteError) {
        console.error(`❌ שגיאה במחיקת ${media.file_path}:`, deleteError);
        continue;
      }
      
      // מחק מהטבלה
      await supabase
        .from('lead_media')
        .delete()
        .eq('id', media.id);
      
      console.log(`✅ נמחק: ${media.file_path}`);
    }
    
    console.log('✅ ניקוי הושלם!');
    
  } catch (error) {
    console.error('❌ שגיאה בניקוי מדיה:', error.message);
  }
}

// הרץ ניקוי כל 24 שעות
setInterval(cleanupExpiredMedia, 24 * 60 * 60 * 1000);

// ========================================
// 🎯 Webhook Endpoint - מקבל הודעות מ-Green API
// ========================================
// שמור הודעות שכבר טופלו
const processedMessages = new Set();

app.post('/webhook/whatsapp', async (req, res) => {
  try {
    console.log('📨 קיבלתי webhook:', JSON.stringify(req.body, null, 2));

    const { typeWebhook, senderData, messageData, instanceData, idMessage } = req.body;
    
    // בדוק אם כבר טיפלנו בהודעה זו
    if (idMessage && processedMessages.has(idMessage)) {
      console.log('⏭️ הודעה כבר טופלה, מדלג...');
      return res.status(200).send('OK - duplicate');
    }
    
    // סמן שטיפלנו בהודעה
    if (idMessage) {
      processedMessages.add(idMessage);
      // נקה הודעות ישנות אחרי דקה
      setTimeout(() => processedMessages.delete(idMessage), 60000);
    }

    // בדוק שזו הודעה נכנסת או יוצאת (מבעל העסק)
    if (typeWebhook !== 'incomingMessageReceived' && typeWebhook !== 'outgoingMessageReceived') {
      return res.status(200).send('OK - not a message');
    }

    // שלוף מידע
    let phoneNumber;
    let targetPhoneNumber = null; // מספר היעד (למי ההודעה נשלחה)
    
    if (typeWebhook === 'outgoingMessageReceived') {
      // הודעה יוצאת - מבעל העסק
      phoneNumber = instanceData.wid.replace('@c.us', '');
      // ב-outgoing, senderData.chatId הוא למי נשלחה ההודעה
      // אם זה לא מספר בעל העסק עצמו, אז זה הלקוח
      const chatId = senderData.chatId.replace('@c.us', '');
      if (normalizePhone(chatId) !== normalizePhone(phoneNumber)) {
        targetPhoneNumber = chatId; // זה המספר של הלקוח
      }
      console.log(`📤 הודעה יוצאת: מ-${phoneNumber} אל-${targetPhoneNumber || 'עצמו'}`);
    } else {
      // הודעה נכנסת - מלקוח
      phoneNumber = senderData.sender.replace('@c.us', '');
    }
    const instanceId = instanceData.idInstance;

    // זיהוי סוג ההודעה
    let messageText = '';
    let mediaUrl = null;
    let mediaType = null;

    if (messageData.typeMessage === 'textMessage') {
      messageText = messageData.textMessageData?.textMessage || '';
    } else if (messageData.typeMessage === 'imageMessage') {
      messageText = messageData.fileMessageData?.caption || 'תמונה';
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      mediaType = 'image';
      console.log('📷 התקבלה תמונה:', mediaUrl);
    } else if (messageData.typeMessage === 'videoMessage') {
      messageText = messageData.fileMessageData?.caption || 'וידאו';
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      mediaType = 'video';
      console.log('🎥 התקבל וידאו:', mediaUrl);
    } else if (messageData.typeMessage === 'documentMessage') {
      messageText = messageData.fileMessageData?.caption || 'קובץ';
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      mediaType = 'document';
      console.log('📎 התקבל קובץ:', mediaUrl);
    } else if (messageData.typeMessage === 'audioMessage') {
      messageText = messageData.fileMessageData?.caption || 'הודעה קולית';
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      mediaType = 'audio';
      console.log('🎤 התקבלה הודעה קולית:', mediaUrl);
      console.log('משך: ', messageData.fileMessageData?.duration, 'שניות');
    }

    console.log(`💬 הודעה מ-${phoneNumber}: ${messageText}`);

    // מצא את העסק
    const business = await findBusinessByInstance(instanceId);
    if (!business) {
      console.log('❌ לא נמצא עסק');
      return res.status(200).send('OK - no business');
    }

    console.log(`✅ עסק נמצא: ${business.business_name}`);

    // בדוק אם זו הודעת תיאום פגישה יוצאת מבעל העסק
    if (typeWebhook === 'outgoingMessageReceived' && targetPhoneNumber && 
        (messageText.includes('להזמנת פגישה') || messageText.includes('בחר') || 
         messageText.includes('המועד המועדף') || messageText.includes('אלו התאריכים הפנויים'))) {
      console.log('📅 זוהתה הודעת תיאום פגישה יוצאת מבעל העסק');
      
      // מצא את הלקוח
      const targetCustomer = await findCustomer(business.id, targetPhoneNumber);
      if (targetCustomer) {
        // מצא את הפנייה האחרונה של הלקוח
        const { data: recentLead } = await supabase
          .from('leads')
          .select('*')
          .eq('customer_id', targetCustomer.id)
          .eq('business_id', business.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
          
        if (recentLead) {
          // עדכן את ה-notes של הלקוח שהוא ממתין לבחירת פגישה
          await supabase
            .from('customers')
            .update({ notes: `[WAITING_FOR_APPOINTMENT_CHOICE]|LEAD:${recentLead.id}` })
            .eq('id', targetCustomer.id);
            
          console.log('✅ עודכן סטטוס הלקוח להמתנה לבחירת פגישה');
        }
      }
    }

    // טפל בהודעה
    console.log(`📨 קורא ל-handleIncomingMessage עם targetPhoneNumber: ${targetPhoneNumber}`);
    await handleIncomingMessage(business, phoneNumber, messageText, mediaUrl, mediaType, targetPhoneNumber);

    res.status(200).send('OK');

  } catch (error) {
    console.error('❌ שגיאה בטיפול ב-webhook:', error);
    res.status(500).send('Error');
  }
});

// ========================================
// 🔍 מצא עסק לפי Green API Instance
// ========================================
async function findBusinessByInstance(instanceId) {
  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .eq('green_api_instance', instanceId)
    .single();

  if (error) {
    console.error('שגיאה בשליפת עסק:', error);
    return null;
  }

  return data;
}

// ========================================
// 💬 טפל בהודעה נכנסת - משופר!
// ========================================
async function handleIncomingMessage(business, phoneNumber, messageText, mediaUrl, mediaType, targetPhoneNumber = null) {
  console.log(`🎯 handleIncomingMessage התחיל`);
  console.log(`📱 Phone: ${phoneNumber}`);
  console.log(`💬 Message: "${messageText}"`);
  console.log(`🎯 Target: ${targetPhoneNumber}`);
  console.log(`💼 Business: ${business.business_name}`);
  
  // ========================================
  // 🎯 בדיקה: האם המספר ברשימה הלבנה?
  // ========================================
  const normalizedPhone = normalizePhone(phoneNumber);
  
  const { data: whitelistEntry } = await supabase
    .from('whitelist_phones')
    .select('*')
    .eq('business_id', business.id)
    .eq('phone', normalizedPhone)
    .single();
  
  if (whitelistEntry) {
    console.log(`📵 מספר ברשימה הלבנה: ${whitelistEntry.name || phoneNumber}`);
    console.log('💬 ההודעה לא תטופל אוטומטית - רק תירשם במערכת');
    
    // רק שמור את ההודעה במערכת אבל אל תשלח תגובה אוטומטית
    // TODO: שמור הודעה ב-messages table
    return; // צא מהפונקציה - אל תמשיך לעיבוד אוטומטי
  }
  
  // ========================================
  // 🔍 בדיקת פנייה פעילה ב-24 שעות האחרונות
  // ========================================
  let customer = await findCustomer(business.id, phoneNumber);
  console.log(`👤 Customer found: ${customer ? customer.name : 'NO'}, Phone: ${phoneNumber}`);
  if (customer) {
    console.log(`📝 Customer notes: "${customer.notes}"`);
    
    // בדיקה ראשונה: האם הלקוח מחכה לבחירת פגישה?
    if (customer.notes && customer.notes.includes('[WAITING_FOR_APPOINTMENT_CHOICE]')) {
      console.log('🗓️ הלקוח בוחר מועד פגישה');
      console.log(`💬 Message text: "${messageText}"`);
      
      const leadIdMatch = customer.notes.match(/LEAD:([a-f0-9-]+)/);
      const leadId = leadIdMatch ? leadIdMatch[1] : null;
      console.log(`🔍 Lead ID found: ${leadId}`);
      
      if (leadId && messageText.trim().match(/^[1-9]$/)) {
        const choiceIndex = parseInt(messageText.trim()) - 1;
        console.log(`✅ Valid choice detected: ${choiceIndex + 1}`);
        
        // שלוף את הפנייה עם האופציות
        const { data: lead } = await supabase
          .from('leads')
          .select('*, businesses(*), customers(*)')
          .eq('id', leadId)
          .single();
        
        if (lead) {
          console.log(`📋 Lead found, checking notes...`);
          console.log(`📋 Lead notes: ${lead.notes || 'NO NOTES'}`);
          
          // בדוק אם הפגישות נשלחו מהאפליקציה
          const isFromApp = customer.notes.includes('FROM_APP');
          console.log(`📱 Is from app: ${isFromApp}`);
          
          if (lead.notes && lead.notes.includes('[APPOINTMENT_OPTIONS]')) {
            const optionsMatch = lead.notes.match(/\[APPOINTMENT_OPTIONS\]\|(.+?)(\n|$)/);
            if (optionsMatch) {
              console.log(`🎯 Options match found: ${optionsMatch[1]}`);
              const options = JSON.parse(optionsMatch[1]);
              console.log(`📅 Available options: ${options.length}`);
              // בדוק שהאינדקס תקין
              if (choiceIndex >= 0 && choiceIndex < options.length) {
                const selectedSlot = options[choiceIndex];
                console.log(`✅ Selected slot:`, selectedSlot);
              // צור פגישה חדשה
              const { data: appointment, error } = await supabase
                .from('appointments')
                .insert({
                  lead_id: leadId,
                  business_id: lead.business_id,
                  customer_id: customer.id,
                  appointment_date: selectedSlot.date,
                  appointment_time: selectedSlot.time + ':00',
                  duration: selectedSlot.duration,
                  status: 'confirmed',
                  location: customer.full_address || lead.customers.address,
                  notes: `נקבעה על ידי הלקוח דרך וואטסאפ`
                })
                .select()
                .single();
              
              if (!error && appointment) {
                const date = new Date(selectedSlot.date);
                const dayName = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'][date.getDay()];
                const dateStr = date.toLocaleDateString('he-IL');
                
                // בדוק אם הפגישות נשלחו מהאפליקציה
                const isFromApp = customer.notes.includes('FROM_APP');
                
                // אשר ללקוח
                await sendWhatsAppMessage(lead.businesses, customer.phone,
                  `✅ *הפגישה נקבעה בהצלחה!*\n\n` +
                  `📅 ${dayName}, ${dateStr}\n` +
                  `⏰ ${selectedSlot.time}\n` +
                  `📍 ${customer.full_address || lead.customers.address}\n\n` +
                  `ניפגש בקרוב! 😊`
                );
                
                // עדכן את בעל העסק
                const confirmationSource = isFromApp ? 'הלקוח אישר דרך האפליקציה' : 'תזכורת תישלח ללקוח יום לפני הפגישה';
                await sendWhatsAppMessage(lead.businesses, normalizePhone(lead.businesses.owner_phone),
                  `✅ *פגישה נקבעה!*\n\n` +
                  `👤 לקוח: ${customer.name}\n` +
                  `📱 טלפון: ${customer.phone}\n` +
                  `📅 ${dayName}, ${dateStr}\n` +
                  `⏰ ${selectedSlot.time}\n` +
                  `📍 ${customer.full_address || lead.customers.address}\n\n` +
                  `💡 ${confirmationSource}`
                );
                
                // נקה את ה-notes
                await supabase
                  .from('customers')
                  .update({ notes: '' })
                  .eq('id', customer.id);
                
                // עדכן את הפנייה
                await supabase
                  .from('leads')
                  .update({ 
                    status: 'scheduled',
                    notes: lead.notes.replace(/\[APPOINTMENT_OPTIONS\]\|.+?(\n|$)/, '[APPOINTMENT_SCHEDULED]')
                  })
                  .eq('id', leadId);
                
                // בדוק אם יש עוד פניות ממתינות לתיאום
                const business = lead.businesses;
                if (business.settings?.pending_scheduling_leads?.length > 0) {
                  const nextLeadId = business.settings.pending_scheduling_leads[0];
                  const remainingLeads = business.settings.pending_scheduling_leads.slice(1);
                  
                  // טען את הפנייה הבאה
                  const { data: nextLead } = await supabase
                    .from('leads')
                    .select('*, customers(*)')
                    .eq('id', nextLeadId)
                    .single();
                  
                  if (nextLead) {
                    // עדכן את הרשימה
                    await supabase
                      .from('businesses')
                      .update({
                        settings: {
                          ...business.settings,
                          current_scheduling_lead: nextLeadId,
                          pending_scheduling_leads: remainingLeads
                        }
                      })
                      .eq('id', business.id);
                    
                    const nextLeadNumber = nextLead.notes?.match(/\d{4}/)?.[0] || nextLead.id.substring(0,8);
                    
                    // הודע לבעל העסק וממשיך לפנייה הבאה
                    await sendWhatsAppMessage(business, normalizePhone(business.owner_phone),
                      `\n➡️ *עובר לפנייה הבאה #${nextLeadNumber}*\n\n` +
                      `👤 ${nextLead.customers.name}\n` +
                      `📍 ${nextLead.customers.address}\n\n` +
                      `⏳ נותרו עוד ${remainingLeads.length} פניות לתיאום`
                    );
                    
                    // התחל תיאום לפנייה הבאה
                    setTimeout(async () => {
                      await startAppointmentScheduling(business, nextLead, nextLead.customers, normalizePhone(business.owner_phone));
                    }, 2000); // המתן 2 שניות
                  }
                } else {
                  // נקה את ההגדרות אם אין עוד פניות
                  await supabase
                    .from('businesses')
                    .update({
                      settings: {
                        ...business.settings,
                        current_scheduling_lead: null,
                        pending_scheduling_leads: []
                      }
                    })
                    .eq('id', business.id);
                }
              } else {
                console.error('❌ Error creating appointment:', error);
                await sendWhatsAppMessage(lead.businesses, customer.phone,
                  '❌ שגיאה בקביעת הפגישה. נסה שוב או צור קשר עם העסק.');
              }
            } else {
              // אופציה לא תקינה
              console.log(`❌ Invalid choice index: ${choiceIndex}, options length: ${options.length}`);
              await sendWhatsAppMessage(lead.businesses, customer.phone,
                `❌ אופציה ${messageText} לא קיימת.\n\nאנא בחר מספר בין 1-${options.length}.`);
            }
          } else {
            console.log('❌ No options match found in notes');
          }
        } else if (isFromApp) {
          // אם הפגישות נשלחו מהאפליקציה, נסה למצוא את האופציות בדרך אחרת
          console.log('🔍 Trying to find appointment options from app...');
          
          // נסה להביא את ה-lead המעודכן
          const { data: updatedLead } = await supabase
            .from('leads')
            .select('notes')
            .eq('id', leadId)
            .single();
            
          if (updatedLead && updatedLead.notes && updatedLead.notes.includes('[APPOINTMENT_OPTIONS]')) {
            const optionsMatch = updatedLead.notes.match(/\[APPOINTMENT_OPTIONS\]\|(.+?)(\n|$)/);
            if (optionsMatch) {
              console.log(`🎯 Found options after refresh: ${optionsMatch[1]}`);
              const options = JSON.parse(optionsMatch[1]);
              
              // עבד את הבחירה
              if (choiceIndex >= 0 && choiceIndex < options.length) {
                const selectedSlot = options[choiceIndex];
                console.log(`✅ Selected slot from app:`, selectedSlot);
                
                // צור פגישה חדשה
                const { data: appointment, error } = await supabase
                  .from('appointments')
                  .insert({
                    lead_id: leadId,
                    business_id: lead.business_id,
                    customer_id: customer.id,
                    appointment_date: selectedSlot.date,
                    appointment_time: selectedSlot.time + ':00',
                    duration: selectedSlot.duration,
                    status: 'confirmed',
                    location: customer.full_address || lead.customers.address,
                    notes: `נקבעה על ידי הלקוח דרך האפליקציה`
                  })
                  .select()
                  .single();
                
                if (!error && appointment) {
                  const date = new Date(selectedSlot.date);
                  const dayName = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'][date.getDay()];
                  const dateStr = date.toLocaleDateString('he-IL');
                  
                  // אשר ללקוח
                  await sendWhatsAppMessage(lead.businesses, customer.phone,
                    `✅ *הפגישה נקבעה בהצלחה!*\n\n` +
                    `📅 ${dayName}, ${dateStr}\n` +
                    `⏰ ${selectedSlot.time}\n` +
                    `📍 ${customer.full_address || lead.customers.address}\n\n` +
                    `ניפגש בקרוב! 😊`
                  );
                  
                  // עדכן את בעל העסק
                  await sendWhatsAppMessage(lead.businesses, normalizePhone(lead.businesses.owner_phone),
                    `✅ *פגישה נקבעה!*\n\n` +
                    `👤 לקוח: ${customer.name}\n` +
                    `📱 טלפון: ${customer.phone}\n` +
                    `📅 ${dayName}, ${dateStr}\n` +
                    `⏰ ${selectedSlot.time}\n` +
                    `📍 ${customer.full_address || lead.customers.address}\n\n` +
                    `💡 הלקוח אישר דרך האפליקציה`
                  );
                  
                  // נקה את ה-notes
                  await supabase
                    .from('customers')
                    .update({ notes: '' })
                    .eq('id', customer.id);
                  
                  // עדכן את הפנייה
                  await supabase
                    .from('leads')
                    .update({ 
                      status: 'scheduled',
                      notes: updatedLead.notes.replace(/\[APPOINTMENT_OPTIONS\]\|.+?(\n|$)/, '[APPOINTMENT_SCHEDULED]')
                    })
                    .eq('id', leadId);
                } else {
                  console.error('❌ Error creating appointment:', error);
                  await sendWhatsAppMessage(lead.businesses, customer.phone,
                    '❌ שגיאה בקביעת הפגישה. נסה שוב או צור קשר עם העסק.');
                }
              } else {
                await sendWhatsAppMessage(lead.businesses, customer.phone,
                  `❌ אופציה ${messageText} לא קיימת.\n\nאנא בחר מספר בין 1-${options.length}.`);
              }
            }
          } else {
            console.log('❌ Still no appointment options found even after refresh');
            await sendWhatsAppMessage(lead.businesses, customer.phone,
              '❌ לא נמצאו אופציות פגישה. אנא בקש מבעל העסק לשלוח שוב.');
          }
        } else {
          console.log('❌ Lead does not contain [APPOINTMENT_OPTIONS] in notes');
        }
      } else {
        console.log('❌ Lead not found with id:', leadId);
      }
      return; // סיים כאן - טיפלנו בבחירת הפגישה
    } else if (leadId) {
        await sendWhatsAppMessage(business, customer.phone,
          '❌ אנא בחר מספר תקין למועד הרצוי.');
        return;
      }
    }
    
  // בדוק אם הלקוח בהתכתבות כללית עם בעל העסק (24 שעות)
  if (customer.notes && customer.notes.includes('[GENERAL_CORRESPONDENCE_24H]')) {
    console.log('🔕 בבדיקת התכתבות כללית...');
      const untilMatch = customer.notes.match(/UNTIL:([^\]]+)/);
      if (untilMatch) {
        const untilDate = new Date(untilMatch[1]);
        if (new Date() < untilDate) {
          // בדוק אם זו תשובה למספר (כנראה תשובה לשאלה)
          if (messageText.trim().match(/^[1-9]$/)) {
            console.log('🔢 זיהיתי תשובה מספרית - כנראה תשובה לשאלה, ממשיך לטפל...');
            // לא מחזירים, ממשיכים לטפל בהודעה
          } else {
            console.log('🔕 לקוח בהתכתבות כללית - לא עונים אוטומטית');
            return; // אל תענה כלל
          }
        } else {
          // פג תוקף ה-24 שעות - נקה את הסימון
          await supabase
            .from('customers')
            .update({ notes: '' })
            .eq('id', customer.id);
        }
      }
    }
    const { data: recentLead } = await supabase
      .from('leads')
      .select('*, quotes(*)')
      .eq('customer_id', customer.id)
      .eq('business_id', business.id)
      .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

      if (recentLead && recentLead.status !== 'completed') {
        console.log('🔕 לקוח עם פנייה פעילה - בודק סטטוס...');
        console.log(`📋 מצב פנייה (24h): ${recentLead.notes || 'ללא מצב'}`);
        
        // בדוק אם יש פגישה מתוזמנת
        if (recentLead.status === 'scheduled') {
          console.log('📅 ללקוח יש פגישה מתוזמנת');
          
          // שלח תזכורת לבעל העסק על ההודעה החדשה
          await sendWhatsAppMessage(business, normalizePhone(business.owner_phone),
            `💬 *הודעה חדשה מלקוח עם פגישה מתוזמנת*\n\n` +
            `👤 ${customer.name}\n` +
            `📱 ${customer.phone}\n` +
            `📝 "${messageText}"\n\n` +
            `📅 יש לכם פגישה מתוזמנת`);
          
          // ענה ללקוח בצורה אישית
          await sendWhatsAppMessage(business, phoneNumber,
            `תודה ${customer.name}! 📨\n\n` +
            `שלחתי את ההודעה שלך ל${business.owner_name || 'בעל העסק'}.\n` +
            `הוא יצור איתך קשר בקרוב.\n\n` +
            `יש לכם פגישה מתוזמנת, ואני כאן אם יש לך שאלות נוספות 😊`);
          
          return;
        }
        
        // בדוק אם בעל העסק מחכה לפעולה מהלקוח
        if (recentLead.notes && recentLead.notes.includes('[WAITING_FOR_OWNER_ACTION]')) {
        console.log('[WAITING_FOR_OWNER_ACTION]');
        
        // אם כבר שאלנו והלקוח ענה, אל תשאל שוב
        if (customer.notes && (customer.notes.includes('[WAITING_FOR_RELATED_LEAD_ANSWER]') || 
            customer.notes.includes('[WAITING_FOR_GENERAL_CORRESPONDENCE]'))) {
          console.log('👀 הלקוח כבר נשאל - ממשיך לטיפול');
          // המשך לטיפול בתשובה
        } else {
          // קודם שאל אם זו פנייה חדשה או בקשר לפנייה קיימת
          const leadNumber = recentLead.notes?.match(/\d{4}/)?.[0] || recentLead.id.substring(0,8);
          
          // בדוק אם יש הצעת מחיר
          if (recentLead.quotes && recentLead.quotes.length > 0) {
            const latestQuote = recentLead.quotes[0];
            
            if (latestQuote.status === 'approved') {
              // הצעה מאושרת - שלח תזכורת ישירות
              await sendWhatsAppMessage(business, normalizePhone(business.owner_phone),
                `💬 *הודעה חדשה מלקוח עם הצעה מאושרת*\n\n` +
                `👤 ${customer.name}\n` +
                `📱 ${customer.phone}\n` +
                `📝 "${messageText}"\n\n` +
                `📋 הצעה #${leadNumber} - מאושרת`);
              
              await sendWhatsAppMessage(business, phoneNumber,
                `תודה ${customer.name}! 📨\n\n` +
                `שלחתי תזכורת ל${business.owner_name || 'בעל העסק'}.\n` +
                `הוא יצור איתך קשר בקרוב לתיאום הפגישה.\n\n` +
                `בינתיים, אני כאן אם יש לך שאלות נוספות 😊`);
              
              return;
            } else if (latestQuote.status === 'pending' || latestQuote.status === 'sent') {
              await sendWhatsAppMessage(business, phoneNumber,
                `שלום ${customer.name}! 👋\n\nאני רואה שיש לך הצעת מחיר שממתינה לאישור.\n\nהאם תרצה לאשר אותה או יש לך שאלות נוספות?`);
              return;
            }
          }
          
          // אין הצעת מחיר - בדוק אם זו התכתבות כללית
          await sendWhatsAppMessage(business, phoneNumber,
            `שלום ${customer.name}! 👋\n\nיש לך פנייה פתוחה #${leadNumber}\n\n` +
            `האם ההודעה הנוכחית קשורה לפנייה זו?\n\n` +
            `▫️ כן - אעביר את ההודעה לבעל העסק\n` +
            `▫️ לא - מה אוכל לעזור לך?`);
          
          await supabase
            .from('customers')
            .update({ notes: `[WAITING_FOR_GENERAL_CORRESPONDENCE]|LEAD:${recentLead.id}|MSG:${messageText}` })
            .eq('id', customer.id);
          return;
        }
      }
      // אחרת - המשך לטיפול רגיל (כנראה פנייה שרק נוצרה)
      console.log('⏩ ממשיך לטפל - פנייה בתהליך יצירה');
    }
  }
  
  // ========================================
  // 🎯 זיהוי: האם זו תגובה מבעל העסק?
  // ========================================
  
  // נרמל את שני המספרים להשוואה
  const normalizedIncoming = normalizePhone(phoneNumber);
  const normalizedOwner = normalizePhone(business.owner_phone);
  
  console.log(`🔍 השוואת מספרים: ${normalizedIncoming} === ${normalizedOwner}`);
  
  if (normalizedIncoming === normalizedOwner) {
    console.log('👨‍💼 הודעה מבעל העסק!');
    
// ========================================
// 📵 בדיקה: האם זו הוספה לרשימה הלבנה?
// ========================================
// תבנית: "פרטי [שם]" או "פרטי: [שם]" או רק "פרטי"
const privateRegex = /^פרטי[:\s]+(.+)/i;
const privateMatch = messageText.match(privateRegex);

if (privateMatch || messageText.trim().toLowerCase() === 'פרטי') {
  console.log('📵 זוהתה בקשה להוספה לרשימה הלבנה');
  console.log(`📞 targetPhoneNumber: ${targetPhoneNumber}`);
  
  // חלץ את השם (אם קיים)
  const contactName = privateMatch ? privateMatch[1].trim() : 'איש קשר פרטי';
  
  // מצא את הלקוח לפי המספר של השיחה
  let customerPhone = null;
  let customerData = null;

  if (targetPhoneNumber) {
    // יש לנו מספר ספציפי - זה הלקוח שאליו בעל העסק עונה
    console.log(`📱 מספר יעד מהשיחה: ${targetPhoneNumber}`);
    customerPhone = normalizePhone(targetPhoneNumber);
    
    // מצא או צור את הלקוח הזה במערכת
    const { data: foundCustomer } = await supabase
      .from('customers')
      .select('*')
      .eq('business_id', business.id)
      .eq('phone', customerPhone)
      .maybeSingle();
    
    if (foundCustomer) {
      customerData = foundCustomer;
      console.log(`👤 לקוח נמצא: ${customerData.name}`);
    } else {
      // אם הלקוח לא קיים, צור אותו
      const { data: newCustomer } = await supabase
        .from('customers')
        .insert({
          business_id: business.id,
          phone: customerPhone,
          name: contactName,
          source: 'whatsapp'
        })
        .select()
        .single();
      
      customerData = newCustomer;
      console.log(`👤 נוצר לקוח חדש: ${contactName}`);
    }
  } else {
    // אין מספר ספציפי - חפש את הפנייה האחרונה
    console.log('🔍 אין מספר יעד - מחפש פנייה אחרונה...');
    const { data: latestLead } = await supabase
      .from('leads')
      .select('*, customers(*)')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (!latestLead || !latestLead.customers) {
      await sendWhatsAppMessage(business, normalizedOwner, 
        '❌ לא נמצא מספר לקוח להוספה.\nאנא ודא שאתה משיב להודעה של לקוח.');
      return;
    }
    
    customerPhone = normalizePhone(latestLead.customers.phone);
    customerData = latestLead.customers;
  }
  
  // בדוק אם המספר כבר ברשימה
  const { data: existingEntry } = await supabase
    .from('whitelist_phones')
    .select('*')
    .eq('business_id', business.id)
    .eq('phone', customerPhone)
    .maybeSingle();
  
  if (existingEntry) {
    await sendWhatsAppMessage(business, normalizedOwner, 
      `⚠️ המספר ${customerPhone} (${existingEntry.name}) כבר ברשימה הלבנה.`);
    return;
  }
  
  // הוסף לרשימה הלבנה
  const { data: newEntry, error: insertError } = await supabase
    .from('whitelist_phones')
    .insert({
      business_id: business.id,
      phone: customerPhone,
      name: contactName,
      notes: `נוסף על ידי ${business.owner_name} בתאריך ${new Date().toLocaleDateString('he-IL')}`
    })
    .select()
    .single();
  
  if (insertError) {
    console.error('❌ שגיאה בהוספה לרשימה הלבנה:', insertError);
    await sendWhatsAppMessage(business, normalizedOwner, 
      `❌ שגיאה בהוספת המספר לרשימה הלבנה.\n${insertError.message}`);
    return;
  }
  
  // אישור הצלחה
  const displayName = customerData && customerData.name && customerData.name !== contactName 
    ? customerData.name 
    : contactName;
    
  await sendWhatsAppMessage(business, normalizedOwner, 
    `✅ *נוסף לרשימה הלבנה*\n\n` +
    `👤 שם: ${displayName}\n` +
    `📱 מספר: ${customerPhone}\n\n` +
    `📵 מעכשיו הבוט לא יענה אוטומטית לפניות ממספר זה.`);
  
  console.log(`✅ נוסף לרשימה הלבנה: ${displayName} - ${customerPhone}`);
  return; // סיום - לא צריך להמשיך לטיפול
}
    // בדוק קודם אם בעל העסק בתהליך תיאום פגישה
    const { data: appointmentLead } = await supabase
      .from('leads')
      .select('*, customers(*)')
      .eq('business_id', business.id)
      .or('notes.like.%[SELECTING_APPOINTMENT_DAYS]%,notes.like.%[SELECTING_APPOINTMENT_TIMES_MULTI]%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (appointmentLead) {
      // בדוק אם בוחר ימים
      if (appointmentLead.notes.includes('[SELECTING_APPOINTMENT_DAYS]')) {
        console.log('🗓️ בעל העסק בוחר ימים לפגישה');
        const optionsMatch = appointmentLead.notes.match(/\[SELECTING_APPOINTMENT_DAYS\]\|(.+?)(\n|$)/);
        if (optionsMatch) {
          const daysOptions = JSON.parse(optionsMatch[1]);
          const selectedIndices = messageText.split(',').map(s => parseInt(s.trim()) - 1);
          
          // בדוק שכל האינדקסים תקינים
          const validIndices = selectedIndices.filter(i => i >= 0 && i < daysOptions.length);
          
          if (validIndices.length > 0 && validIndices.length <= 3) {
            const selectedDays = validIndices.map(i => daysOptions[i]);
            
            // צור אובייקט לשמירת כל השעות הזמינות לכל יום
            const allDaySlots = {};
            
            // חשב שעות פנויות לכל יום שנבחר
            for (const day of selectedDays) {
              const slots = await calculateDaySlots(
                business.id, 
                day.date, 
                day.availability
              );
              
              if (slots.length > 0) {
                allDaySlots[day.date] = {
                  day: day,
                  slots: slots
                };
              }
            }
            
            if (Object.keys(allDaySlots).length === 0) {
              await sendWhatsAppMessage(business, normalizedOwner,
                '❌ אין שעות פנויות בימים שנבחרו. בחר ימים אחרים.');
              return;
            }
            
            // התחל תהליך בחירת שעות - יום אחרי יום
            const firstDayKey = Object.keys(allDaySlots)[0];
            const firstDay = allDaySlots[firstDayKey];
            
            // הצג שעות לבחירה ליום הראשון
            let message = `📅 *${firstDay.day.dayName} ${firstDay.day.displayDate}*\n\n`;
            message += '⏰ *בחר שעות לפגישה:*\n';
            message += '(תוכל לבחור עד 3 אופציות)\n\n';
            
            firstDay.slots.forEach((slot, index) => {
              message += `${index + 1}. ${slot.time}\n`;
            });
            
            message += '\n*דוגמה:* 1,3,5 (לבחירת שעות 1, 3 ו-5)\n';
            message += 'או 0 כדי לדלג על יום זה';
            
            // עדכן את ה-notes
            await supabase
              .from('leads')
              .update({ 
                notes: appointmentLead.notes.replace(
                  /\[SELECTING_APPOINTMENT_DAYS\]\|.+?(\n|$)/, 
                  `[SELECTING_APPOINTMENT_TIMES_MULTI]|${JSON.stringify({
                    allDays: allDaySlots,
                    currentDayIndex: 0,
                    currentDayKey: firstDayKey,
                    selectedSlots: []
                  })}`
                )
              })
              .eq('id', appointmentLead.id);
            
            await sendWhatsAppMessage(business, normalizedOwner, message);
            return;
          } else {
            await sendWhatsAppMessage(business, normalizedOwner,
              '❌ אנא בחר 1-3 ימים מהרשימה.\nדוגמה: 1,3,5');
            return;
          }
        }
      }
      
      // בדוק אם בוחר שעות (מרובות ימים)
      if (appointmentLead.notes.includes('[SELECTING_APPOINTMENT_TIMES_MULTI]')) {
        console.log('⏰ בעל העסק בוחר שעות לפגישה (מרובה ימים)');
        const optionsMatch = appointmentLead.notes.match(/\[SELECTING_APPOINTMENT_TIMES_MULTI\]\|(.+?)(\n|$)/);
        if (optionsMatch) {
          const state = JSON.parse(optionsMatch[1]);
          
          // אם המשתמש בחר 0, דלג על היום הנוכחי
          if (messageText.trim() === '0') {
            state.currentDayIndex++;
          } else {
            // אחרת, טפל בבחירת השעות
            const selectedIndices = messageText.split(',').map(s => parseInt(s.trim()) - 1);
            const currentDay = state.allDays[state.currentDayKey];
            
            // בדוק שכל האינדקסים תקינים
            const validIndices = selectedIndices.filter(i => i >= 0 && i < currentDay.slots.length);
            
            if (validIndices.length > 0 && validIndices.length <= 3) {
              // הוסף את השעות שנבחרו
              validIndices.forEach(i => {
                state.selectedSlots.push({
                  date: currentDay.day.date,
                  dayName: currentDay.day.dayName,
                  displayDate: currentDay.day.displayDate,
                  time: currentDay.slots[i].time,
                  duration: currentDay.slots[i].duration
                });
              });
              
              state.currentDayIndex++;
            } else {
              await sendWhatsAppMessage(business, normalizedOwner,
                '❌ אנא בחר 1-3 שעות מהרשימה, או 0 לדילוג.\nדוגמה: 1,3,5');
              return;
            }
          }
          
          // בדוק אם יש עוד ימים לבחירה
          const dayKeys = Object.keys(state.allDays);
          if (state.currentDayIndex < dayKeys.length) {
            // עבור ליום הבא
            state.currentDayKey = dayKeys[state.currentDayIndex];
            const nextDay = state.allDays[state.currentDayKey];
            
            let message = `📅 *${nextDay.day.dayName} ${nextDay.day.displayDate}*\n\n`;
            message += '⏰ *בחר שעות לפגישה:*\n';
            message += '(תוכל לבחור עד 3 אופציות)\n\n';
            
            nextDay.slots.forEach((slot, index) => {
              message += `${index + 1}. ${slot.time}\n`;
            });
            
            message += '\n*דוגמה:* 1,3,5 (לבחירת שעות 1, 3 ו-5)\n';
            message += 'או 0 כדי לדלג על יום זה';
            
            // עדכן את ה-state
            await supabase
              .from('leads')
              .update({ 
                notes: appointmentLead.notes.replace(
                  /\[SELECTING_APPOINTMENT_TIMES_MULTI\]\|.+?(\n|$)/, 
                  `[SELECTING_APPOINTMENT_TIMES_MULTI]|${JSON.stringify(state)}`
                )
              })
              .eq('id', appointmentLead.id);
            
            await sendWhatsAppMessage(business, normalizedOwner, message);
            return;
          } else {
            // סיימנו לעבור על כל הימים
            if (state.selectedSlots.length === 0) {
              await sendWhatsAppMessage(business, normalizedOwner,
                '❌ לא נבחרו שעות כלל. נסה שוב.');
              return;
            }
            
            // שלח את כל האופציות ללקוח
            let message = `שלום ${appointmentLead.customers.name}! 🎉\n\n`;
            message += `${business.owner_name || 'בעל העסק'} מוכן לתאם פגישה.\n`;
            message += `בחר/י את המועד המועדף:\n\n`;
            
            state.selectedSlots.forEach((slot, index) => {
              message += `${index + 1}️⃣ *${slot.dayName} ${slot.displayDate}*\n`;
              message += `   ⏰ ${slot.time}\n\n`;
            });
            
            message += `השב/י עם המספר של המועד המועדף (1-${state.selectedSlots.length})`;
            
            // שמור את האופציות שנבחרו
            await supabase
              .from('leads')
              .update({ 
                notes: appointmentLead.notes.replace(
                  /\[SELECTING_APPOINTMENT_TIMES_MULTI\]\|.+?(\n|$)/, 
                  `[APPOINTMENT_OPTIONS]|${JSON.stringify(state.selectedSlots)}`
                )
              })
              .eq('id', appointmentLead.id);
            
            await sendWhatsAppMessage(business, appointmentLead.customers.phone, message);
            
            // עדכן את הסטטוס של הלקוח
            await supabase
              .from('customers')
              .update({ notes: `[WAITING_FOR_APPOINTMENT_CHOICE]|LEAD:${appointmentLead.id}` })
              .eq('id', appointmentLead.customers.id);
            
            // הודע לבעל העסק
            await sendWhatsAppMessage(business, normalizedOwner,
              `✅ שלחתי ${state.selectedSlots.length} אופציות לתיאום פגישה ללקוח.\n\nאחכה לתשובתו ואעדכן אותך.`);
            return;
          }
        }
      }
    }
    
    // מצא את הפנייה האחרונה שממתינה לפעולה
    console.log('🔍 מחפש פנייה ממתינה לפעולה...');
    const { data: allPendingLeads } = await supabase
      .from('leads')
      .select('*, customers(*)')
      .eq('business_id', business.id)
      .in('status', ['new', 'quoted'])
      .like('notes', '%[WAITING_FOR_OWNER_ACTION]%')
      .order('created_at', { ascending: false });
    
    console.log(`📋 נמצאו ${allPendingLeads?.length || 0} פניות ממתינות`);
    
    // בחר את הפנייה החדשה ביותר
    const pendingLead = allPendingLeads && allPendingLeads.length > 0 ? allPendingLeads[0] : null;
    
    if (pendingLead) {
      console.log(`✅ נבחרה פנייה: ${pendingLead.notes?.match(/פנייה #(\d+)/)?.[1]} של ${pendingLead.customers?.name}`);
    }
    
    // בדוק אם זו בחירת אופציה בודדת (1, 2, 3, 4)
    if (messageText.trim() === '1' && pendingLead) {
      console.log('💰 בעל העסק בחר: צור הצעת מחיר');
      
      // הצג רשימת מוצרים
      const { data: products } = await supabase
        .from('products')
        .select('*')
        .eq('business_id', business.id)
        .eq('is_active', true)
        .order('name');
      
      if (products && products.length > 0) {
        let productMessage = `📦 *בחר מוצרים להצעת מחיר:*\n\n`;
        
        products.forEach((product, index) => {
          productMessage += `*${index + 1}.* ${product.name}\n`;
          productMessage += `   💰 ₪${parseFloat(product.base_price).toFixed(2)}\n`;
          if (product.description) {
            productMessage += `   📝 ${product.description.substring(0, 50)}${product.description.length > 50 ? '...' : ''}\n`;
          }
          productMessage += `\n`;
        });
        
        productMessage += `━━━━━━━━━━━━━━━━\n`;
        productMessage += `📝 *השב עם מספרי המוצרים מופרדים בפסיקים*\n`;
        productMessage += `*דוגמה:* 1,3,5`;
        
        // עדכן את ה-notes לשלב הבא
        await supabase
          .from('leads')
          .update({ 
            notes: pendingLead.notes.replace('[WAITING_FOR_OWNER_ACTION]', '[Waiting for quote selection]') 
          })
          .eq('id', pendingLead.id);
        
        await sendWhatsAppMessage(business, normalizedOwner, productMessage);
      } else {
        await sendWhatsAppMessage(business, normalizedOwner, 
          '❌ לא נמצאו מוצרים פעילים במערכת.\nיש להוסיף מוצרים דרך המערכת.');
      }
      return;
    }
    
    if (messageText.trim() === '2' && pendingLead) {
      console.log('📅 בעל העסק בחר: תאם פגישה');
      
      // בדוק אם יש הצעה מאושרת
      const { data: approvedQuote } = await supabase
        .from('quotes')
        .select('*')
        .eq('lead_id', pendingLead.id)
        .eq('status', 'approved')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (approvedQuote) {
        // אם יש הצעה מאושרת, התחל תיאום
        await supabase
          .from('leads')
          .update({ notes: (pendingLead.notes || '') + '\n[READY_FOR_APPOINTMENT]' })
          .eq('id', pendingLead.id);
        
        await startAppointmentScheduling(business, pendingLead, pendingLead.customers, normalizedOwner);
      } else {
        // אם אין הצעה מאושרת, הודע שצריך קודם אישור
        await sendWhatsAppMessage(business, normalizedOwner, 
          `⚠️ *לא ניתן לתאם פגישה*\n\nהלקוח טרם אישר את הצעת המחיר.\n\nאופציות:\n1️⃣ צור הצעת מחיר\n3️⃣ התקשר ללקוח\n4️⃣ פתח WhatsApp`);
      }
      return;
    }
    
    if (messageText.trim() === '3' && pendingLead) {
      console.log('📞 בעל העסק בחר: התקשר ללקוח');
      
      if (pendingLead && pendingLead.customers) {
        const contactUrl = `tel:${pendingLead.customers.phone}`;
        await sendWhatsAppMessage(business, normalizedOwner, 
          `📞 *פרטי הלקוח לחיוג:*\n\n👤 ${pendingLead.customers.name}\n📱 ${pendingLead.customers.phone}\n📍 ${pendingLead.customers.address}${pendingLead.customers.city ? `, ${pendingLead.customers.city}` : ''}\n\n🔗 לחץ לחיוג: ${contactUrl}`);
        
        // הצג רשימת פניות אם יש עוד
        setTimeout(async () => {
          await showPendingLeads(business, normalizedOwner);
        }, 2000);
      }
      return;
    }
    
    if (messageText.trim() === '4' && pendingLead) {
      console.log('💬 בעל העסק בחר: פתח WhatsApp');
      
      if (pendingLead && pendingLead.customers) {
        const whatsappUrl = `https://wa.me/${pendingLead.customers.phone}`;
        await sendWhatsAppMessage(business, normalizedOwner, 
          `💬 *פתח שיחת WhatsApp עם הלקוח:*\n\n👤 ${pendingLead.customers.name}\n📱 ${pendingLead.customers.phone}\n\n🔗 לחץ לפתיחת שיחה: ${whatsappUrl}`);
      }
      return;
    }
    
    // בדוק אם זה מספר פנייה (4 ספרות)
    const leadNumberMatch = messageText.match(/^(\d{4})$/);
    if (leadNumberMatch) {
      const leadNumber = leadNumberMatch[1];
      console.log(`📋 בעל העסק בחר פנייה #${leadNumber}`);
      
      // מצא את הפנייה לפי מספר
      const { data: targetLead } = await supabase
        .from('leads')
        .select('*, customers(*)')
        .eq('business_id', business.id)
        .like('notes', `%פנייה #${leadNumber}%`)
        .single();
      
      if (targetLead) {
        // עדכן שזו הפנייה הנוכחית
        await supabase
          .from('leads')
          .update({ 
            notes: targetLead.notes + '\n[WAITING_FOR_OWNER_ACTION]' 
          })
          .eq('id', targetLead.id);
        
        // שלח תפריט פעולות
        await sendWhatsAppMessage(business, normalizedOwner,
          `📋 *פנייה #${leadNumber}*\n\n👤 ${targetLead.customers.name}\n📱 ${targetLead.customers.phone}\n\n💼 *מה תרצה לעשות?*\n\n1️⃣ צור הצעת מחיר\n2️⃣ תאם פגישה\n3️⃣ התקשר ללקוח\n4️⃣ פתח WhatsApp\n\nהשב 1-4`);
      } else {
        await sendWhatsAppMessage(business, normalizedOwner,
          `❌ לא נמצאה פנייה #${leadNumber}`);
      }
      return;
    }
    
    // קודם בדוק אם יש הצעה שממתינה לעריכה או להוספת מוצרים
    const { data: editQuote, error: editQuoteError } = await supabase
      .from('quotes')
      .select('*, quote_items(*), leads(*, customers(*))')
      .eq('status', 'pending_owner_approval')
      .eq('business_id', business.id)  // חשוב! לסנן רק הצעות של העסק הנוכחי
      .like('notes', '%[WAITING_FOR_EDIT_CHOICE]%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (editQuote) {
      console.log(`📝 נמצאה הצעה עם notes: ${editQuote.notes}`);
    }
    
    // אם יש הצעה לעריכה ונשלח מספר בודד - זו בחירת עריכה
    // אבל רק אם ההצעה באמת ממתינה לבחירת עריכה ולא להוספת מוצרים
    if (editQuote && messageText.trim().match(/^[1-7]$/) && 
        editQuote.notes.includes('[WAITING_FOR_EDIT_CHOICE]')) {
      console.log(`📝 טיפול בבחירת עריכה: ${messageText}`);
      
      // טיפול בבחירות עריכה (1-6)
      if (messageText.trim() === '1') {
        console.log('📝 בעל העסק בחר: שינוי כמות');
        // עבור מייד להצגת רשימת פריטים
        let itemsList = `📋 *בחר פריט לשינוי כמות:*\n\n`;
        editQuote.quote_items.forEach((item, index) => {
          itemsList += `*${index + 1}. ${item.product_name || item.products?.name}*\n`;
          itemsList += `   כמות נוכחית: ${item.quantity} יח'\n`;
          itemsList += `   מחיר ליחידה: ₪${item.unit_price.toFixed(2)}\n\n`;
        });
        
        itemsList += `━━━━━━━━━━━━━━━━\n`;
        itemsList += `👆 *שלח את מספר הפריט שברצונך לשנות*\n`;
        itemsList += `לדוגמה: 1`;
        
        await sendWhatsAppMessage(business, normalizedOwner, itemsList);
        await supabase.from('quotes').update({ notes: '[WAITING_FOR_QUANTITY_ITEM_SELECTION]' }).eq('id', editQuote.id);
        return;
      }
      
      if (messageText.trim() === '2') {
        console.log('💰 בעל העסק בחר: שינוי מחיר');
        // עבור מייד להצגת רשימת פריטים
        let itemsList = `💰 *בחר פריט לשינוי מחיר:*\n\n`;
        editQuote.quote_items.forEach((item, index) => {
          itemsList += `*${index + 1}. ${item.product_name || item.products?.name}*\n`;
          itemsList += `   כמות: ${item.quantity} יח'\n`;
          itemsList += `   מחיר נוכחי: ₪${item.unit_price.toFixed(2)}\n\n`;
        });
        
        itemsList += `━━━━━━━━━━━━━━━━\n`;
        itemsList += `👆 *שלח את מספר הפריט שברצונך לשנות*\n`;
        itemsList += `לדוגמה: 1`;
        
        await sendWhatsAppMessage(business, normalizedOwner, itemsList);
        await supabase.from('quotes').update({ notes: '[WAITING_FOR_PRICE_ITEM_SELECTION]' }).eq('id', editQuote.id);
        return;
      }
      
      if (messageText.trim() === '3') {
        console.log('✅ בעל העסק אישר הצעה');
        await handleOwnerApproval(business, editQuote.id);
        return;
      }
      
      if (messageText.trim() === '4') {
        console.log('❌ בעל העסק ביטל הצעה');
        await supabase.from('quotes').delete().eq('id', editQuote.id);
        await sendWhatsAppMessage(business, normalizedOwner, '✅ ההצעה בוטלה.');
        // הצג רשימת פניות
        await showPendingLeads(business, normalizedOwner);
        return;
      }
      
      if (messageText.trim() === '5') {
        console.log('📋 בעל העסק מבקש לחזור לרשימת פניות');
        // נקה את הסימון מההצעה
        await supabase.from('quotes').update({ notes: '' }).eq('id', editQuote.id);
        // הצג רשימת פניות
        await showPendingLeads(business, normalizedOwner);
        return;
      }
    }
    
    if (editQuoteError) {
      console.log('⚠️ לא נמצאה הצעה לעריכה:', editQuoteError.message);
    }
    
    // בדוק אם יש מצב עריכה פעיל - חשוב לבדוק לפני בחירת מוצרים!
    const { data: anyEditQuote } = await supabase
      .from('quotes')
      .select('notes')
      .eq('status', 'pending_owner_approval')
      .eq('business_id', business.id)
      .or('notes.like.%[WAITING_FOR_QUANTITY_CHANGE]%,notes.like.%[WAITING_FOR_PRICE_CHANGE]%,notes.like.%[WAITING_FOR_QUANTITY_ITEM_SELECTION]%,notes.like.%[WAITING_FOR_PRICE_ITEM_SELECTION]%,notes.like.%[WAITING_FOR_NEW_QUANTITY]%,notes.like.%[WAITING_FOR_NEW_PRICE]%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    // אם יש מצב עריכה ונשלח מספרים עם פסיק - אל תפרש כבחירת מוצרים!
    const isInEditMode = anyEditQuote && anyEditQuote.notes && (
      anyEditQuote.notes.includes('[WAITING_FOR_QUANTITY_CHANGE]') ||
      anyEditQuote.notes.includes('[WAITING_FOR_PRICE_CHANGE]') ||
      anyEditQuote.notes.includes('[WAITING_FOR_QUANTITY_ITEM_SELECTION]') ||
      anyEditQuote.notes.includes('[WAITING_FOR_PRICE_ITEM_SELECTION]') ||
      anyEditQuote.notes.includes('[WAITING_FOR_NEW_QUANTITY]') ||
      anyEditQuote.notes.includes('[WAITING_FOR_NEW_PRICE]')
    );
    
    // בדוק קודם אם בעל העסק כתב "פגישה"
    if (messageText.toLowerCase().includes('פגישה')) {
      console.log('🗓️ בעל העסק רוצה לתאם פגישה');
      
      // מצא פניות עם הצעות שנשלחו או אושרו
      const { data: leadsWithQuotes } = await supabase
        .from('leads')
        .select('*, customers(*), quotes(*)')
        .eq('business_id', business.id)
        .order('created_at', { ascending: false });
        
      // סנן רק פניות עם הצעות שנשלחו או אושרו
      const readyLeads = leadsWithQuotes?.filter(lead => 
        lead.quotes?.some(quote => ['approved', 'sent'].includes(quote.status))
      ) || [];
        
      if (readyLeads && readyLeads.length > 0) {
        const lead = readyLeads[0];
        const customer = lead.customers;
        await startAppointmentScheduling(business, lead, customer, normalizedOwner);
        return;
      } else {
        await sendWhatsAppMessage(business, normalizedOwner, 
          '❌ לא נמצאה פנייה עם הצעת מחיר מאושרת לתיאום פגישה.\n\nיש לוודא שהלקוח אישר את ההצעה לפני תיאום פגישה.');
        return;
      }
    }
    
    // בדוק אם יש פנייה שמחכה לבחירת מוצרים
    const { data: productSelectionLead } = await supabase
      .from('leads')
      .select('*')
      .eq('business_id', business.id)
      .eq('status', 'new')
      .like('notes', '%[Waiting for quote selection]%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    // אם יש פנייה שמחכה לבחירת מוצרים ונשלחו מספרים
    // אבל לא 99 (שזה הנחה כללית) ולא במצב עריכה
    if (productSelectionLead && messageText.match(/^[\d,\s]+$/) && messageText.trim() !== '99' && !isInEditMode) {
      console.log('📝 בעל העסק בחר מוצרים:', messageText);
      await handleOwnerProductSelection(business, messageText);
      return;
    }
    
    // אם זו בחירת מוצרים ואין מצב עריכה פעיל
    if (!isInEditMode && messageText.match(/^[\d,\s]+$/)) {
      // אם זה מספר בודד, כנראה ניסה לערוך או לבחור
      if (messageText.trim().match(/^[1-9]$/) || messageText.trim() === '99') {
        // בדוק אם יש הצעה כלשהי (אולי במצב אחר)
        const { data: anyQuote } = await supabase
          .from('quotes')
          .select('*, quote_items(*)')
          .eq('status', 'pending_owner_approval')
          .eq('business_id', business.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();
        
        if (anyQuote) {
          console.log(`🔍 נמצאה הצעה במצב: ${anyQuote.notes}`);
          // אם יש הצעה אבל היא לא במצב עריכה רגיל, תן הודעה ברורה
        }
        
        console.log('⚠️ בעל העסק ניסה לערוך אבל אין הצעה פעילה');
        await sendWhatsAppMessage(business, normalizedOwner, 
          `❌ לא נמצאה הצעת מחיר פעילה לעריכה.\n\nאפשרויות:\n1️⃣ בחר פנייה (למשל: 1001)\n2️⃣ צור הצעת מחיר חדשה`);
        return;
      }
      // אחרת זו בחירת מוצרים
      console.log('📝 בעל העסק בחר מוצרים:', messageText);
      await handleOwnerProductSelection(business, messageText);
      return;
    }
    
    // בדוק אם בעל העסק בתהליך שינוי כמות
    const { data: quantityChangeQuote } = await supabase
      .from('quotes')
      .select('*, quote_items(*, products(*))')
      .eq('status', 'pending_owner_approval')
      .eq('business_id', business.id)
      .like('notes', '%[WAITING_FOR_QUANTITY_CHANGE]%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (quantityChangeQuote) {
      console.log('📝 טיפול בשינוי כמות');
      
      // אם זו פקודה ראשונית (1) - הצג רשימת פריטים לבחירה
      if (messageText.trim() === '1') {
        let itemsList = `📋 *בחר פריט לשינוי כמות:*\n\n`;
        quantityChangeQuote.quote_items.forEach((item, index) => {
          itemsList += `*${index + 1}. ${item.products.name}*\n`;
          itemsList += `   כמות נוכחית: ${item.quantity} יח'\n`;
          itemsList += `   מחיר ליחידה: ₪${item.unit_price.toFixed(2)}\n\n`;
        });
        
        itemsList += `━━━━━━━━━━━━━━━━\n`;
        itemsList += `👆 *שלח את מספר הפריט שברצונך לשנות*\n`;
        itemsList += `לדוגמה: 1`;
        
        // עדכן את הסטטוס לבחירת פריט לכמות
        await supabase.from('quotes').update({ 
          notes: '[WAITING_FOR_QUANTITY_ITEM_SELECTION]' 
        }).eq('id', quantityChangeQuote.id);
        
        await sendWhatsAppMessage(business, normalizedOwner, itemsList);
        return;
      }
      
      // לא צריך לפרסר כאן - רק להעביר לבחירת פריט
      await sendWhatsAppMessage(business, normalizedOwner, 
        '❌ אנא בחר מספר פריט מהרשימה (1-' + quantityChangeQuote.quote_items.length + ')');
      return;
    }
    
    // בדוק אם בעל העסק בוחר פריט לשינוי כמות
    const { data: quantityItemSelect } = await supabase
      .from('quotes')
      .select('*, quote_items(*, products(*))')
      .eq('status', 'pending_owner_approval')
      .eq('business_id', business.id)
      .like('notes', '%[WAITING_FOR_QUANTITY_ITEM_SELECTION]%')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (quantityItemSelect) {
      const itemIndex = parseInt(messageText.trim()) - 1;
      
      if (itemIndex >= 0 && itemIndex < quantityItemSelect.quote_items.length) {
        const selectedItem = quantityItemSelect.quote_items[itemIndex];
        
        await sendWhatsAppMessage(business, normalizedOwner,
          `📦 *${selectedItem.products.name}*\n\n` +
          `כמות נוכחית: ${selectedItem.quantity} יח'\n\n` +
          `🔢 *מה הכמות החדשה?*\n` +
          `רשום רק מספר, לדוגמה: 5`
        );
        
        // שמור איזה פריט נבחר
        await supabase.from('quotes').update({ 
          notes: `[WAITING_FOR_NEW_QUANTITY]:${itemIndex}` 
        }).eq('id', quantityItemSelect.id);
        
        return;
      } else {
        await sendWhatsAppMessage(business, normalizedOwner, 
          '❌ מספר פריט לא תקין. בחר מספר מהרשימה.');
        return;
      }
    }
    
    // בדוק אם בעל העסק מזין כמות חדשה
    const { data: newQuantityQuote } = await supabase
      .from('quotes')
      .select('*, quote_items(*, products(*))')
      .eq('status', 'pending_owner_approval')
      .eq('business_id', business.id)
      .like('notes', '%[WAITING_FOR_NEW_QUANTITY]%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (newQuantityQuote) {
      const newQuantity = parseInt(messageText.trim());
      
      if (newQuantity > 0) {
        // חלץ את האינדקס מה-notes
        const itemIndex = parseInt(newQuantityQuote.notes.match(/\[WAITING_FOR_NEW_QUANTITY\]:(\d+)/)[1]);
        const item = newQuantityQuote.quote_items[itemIndex];
        const newItemTotal = item.unit_price * newQuantity;
        
        // עדכן את הכמות
        await supabase
          .from('quote_items')
          .update({
            quantity: newQuantity,
            total_price: newItemTotal
          })
          .eq('id', item.id);
        
        // חשב מחדש את הסכום הכולל
        const { data: updatedItems } = await supabase
          .from('quote_items')
          .select('*')
          .eq('quote_id', newQuantityQuote.id);
        
        const newQuoteTotal = updatedItems.reduce((sum, item) => sum + item.total_price, 0);
        
        // עדכן את ההצעה
        await supabase
          .from('quotes')
          .update({
            amount: newQuoteTotal,
            notes: '[WAITING_FOR_EDIT_CHOICE]'
          })
          .eq('id', newQuantityQuote.id);
        
        // הצג הצעה מעודכנת
        await showUpdatedQuote(business, newQuantityQuote.id, normalizedOwner);
        return;
      } else {
        await sendWhatsAppMessage(business, normalizedOwner, 
          '❌ אנא הזן כמות חוקית (מספר חיובי)');
        return;
      }
    }
    
    // בדוק אם בעל העסק בתהליך שינוי מחיר
    const { data: priceChangeQuote } = await supabase
      .from('quotes')
      .select('*, quote_items(*, products(*))')
      .eq('status', 'pending_owner_approval')
      .eq('business_id', business.id)
      .like('notes', '%[WAITING_FOR_PRICE_CHANGE]%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (priceChangeQuote) {
      console.log('💰 טיפול בשינוי מחיר');
      
      // אם זו פקודה ראשונית (2) - הצג רשימת פריטים לבחירה
      if (messageText.trim() === '2') {
        let itemsList = `💰 *בחר פריט לשינוי מחיר:*\n\n`;
        priceChangeQuote.quote_items.forEach((item, index) => {
          itemsList += `*${index + 1}. ${item.products.name}*\n`;
          itemsList += `   כמות: ${item.quantity} יח'\n`;
          itemsList += `   מחיר נוכחי: ₪${item.unit_price.toFixed(2)}\n\n`;
        });
        
        itemsList += `━━━━━━━━━━━━━━━━\n`;
        itemsList += `👆 *שלח את מספר הפריט שברצונך לשנות*\n`;
        itemsList += `לדוגמה: 1`;
        
        // עדכן את הסטטוס לבחירת פריט למחיר
        await supabase.from('quotes').update({ 
          notes: '[WAITING_FOR_PRICE_ITEM_SELECTION]' 
        }).eq('id', priceChangeQuote.id);
        
        await sendWhatsAppMessage(business, normalizedOwner, itemsList);
        return;
      }
      
      // לא צריך לפרסר כאן - רק להעביר לבחירת פריט
      await sendWhatsAppMessage(business, normalizedOwner, 
        '❌ אנא בחר מספר פריט מהרשימה (1-' + priceChangeQuote.quote_items.length + ')');
      return;
    }
    
    
    // בדוק אם בעל העסק בוחר פריט לשינוי מחיר
    const { data: priceItemSelect } = await supabase
      .from('quotes')
      .select('*, quote_items(*, products(*))')
      .eq('status', 'pending_owner_approval')
      .eq('business_id', business.id)
      .like('notes', '%[WAITING_FOR_PRICE_ITEM_SELECTION]%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (priceItemSelect) {
      console.log(`💰 בעל העסק בוחר פריט לשינוי מחיר: ${messageText}`);
      
      // בדוק אם כתב "ביטול" או "חזור"
      if (messageText.includes('ביטול') || messageText.includes('חזור')) {
        await supabase.from('quotes').update({ 
          notes: '[WAITING_FOR_EDIT_CHOICE]' 
        }).eq('id', priceItemSelect.id);
        await showUpdatedQuote(business, priceItemSelect.id, normalizedOwner);
        return;
      }
      
      const itemNumber = parseInt(messageText.trim());
      
      // בדוק אם זה לא מספר בכלל
      if (isNaN(itemNumber)) {
        await sendWhatsAppMessage(business, normalizedOwner, 
          `❌ אנא הזן מספר פריט (1-${priceItemSelect.quote_items.length})\n\nאו כתוב "ביטול" לחזרה לתפריט`);
        return;
      }
      
      const itemIndex = itemNumber - 1;
      
      if (itemIndex >= 0 && itemIndex < priceItemSelect.quote_items.length) {
        const selectedItem = priceItemSelect.quote_items[itemIndex];
        
        await sendWhatsAppMessage(business, normalizedOwner,
          `💰 *${selectedItem.product_name || selectedItem.products?.name || 'מוצר'}*\n\n` +
          `מחיר נוכחי: ₪${selectedItem.unit_price.toFixed(2)}\n` +
          `כמות: ${selectedItem.quantity} יח'\n\n` +
          `💵 *מה המחיר החדש ליחידה?*\n` +
          `רשום רק מספר, לדוגמה: 250`
        );
        
        // שמור איזה פריט נבחר
        await supabase.from('quotes').update({ 
          notes: `[WAITING_FOR_NEW_PRICE]:${itemIndex}` 
        }).eq('id', priceItemSelect.id);
        
        return;
      } else {
        await sendWhatsAppMessage(business, normalizedOwner, 
          `❌ מספר פריט לא תקין (${itemNumber}).\n\nבחר מספר מ-1 עד ${priceItemSelect.quote_items.length}`);
        return;
      }
    }
    
    // בדוק אם בעל העסק מזין מחיר חדש
    const { data: newPriceQuote } = await supabase
      .from('quotes')
      .select('*, quote_items(*, products(*))')
      .eq('status', 'pending_owner_approval')
      .eq('business_id', business.id)
      .like('notes', '%[WAITING_FOR_NEW_PRICE]%')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    
    if (newPriceQuote) {
      const newPrice = parseFloat(messageText.trim());
      
      if (newPrice > 0) {
        // חלץ את האינדקס מה-notes
        const itemIndex = parseInt(newPriceQuote.notes.match(/\[WAITING_FOR_NEW_PRICE\]:(\d+)/)[1]);
        const item = newPriceQuote.quote_items[itemIndex];
        const newItemTotal = newPrice * item.quantity;
        
        // עדכן את המחיר
        await supabase
          .from('quote_items')
          .update({
            unit_price: newPrice,
            total_price: newItemTotal
          })
          .eq('id', item.id);
        
        // חשב מחדש את הסכום הכולל
        const { data: updatedItems } = await supabase
          .from('quote_items')
          .select('*')
          .eq('quote_id', newPriceQuote.id);
        
        const newQuoteTotal = updatedItems.reduce((sum, item) => sum + item.total_price, 0);
        
        // עדכן את ההצעה
        await supabase
          .from('quotes')
          .update({
            amount: newQuoteTotal,
            notes: '[WAITING_FOR_EDIT_CHOICE]'
          })
          .eq('id', newPriceQuote.id);
        
        // הצג הצעה מעודכנת
        await showUpdatedQuote(business, newPriceQuote.id, normalizedOwner);
        return;
      } else {
        await sendWhatsAppMessage(business, normalizedOwner, 
          '❌ אנא הזן מחיר תקין (מספר חיובי)');
        return;
      }
    }
    
    
    // בדוק אם זו תשובה מיוחדת
    if (messageText.toLowerCase().includes('אישור')) {
      console.log('✅ בעל העסק אישר הצעה');
      await handleOwnerApproval(business);
      return;
    }
    
    if (messageText.toLowerCase() === 'פניות' || messageText === 'רשימה') {
      console.log('📋 בעל העסק מבקש לראות רשימת פניות');
      await showPendingLeads(business, normalizedOwner);
      return;
    }
    
    if (messageText.toLowerCase().includes('פגישה')) {
      console.log('🗓️ בעל העסק רוצה לתאם פגישה');
      
      // מצא פניות עם הצעות שנשלחו או אושרו
      const { data: leadsWithQuotes } = await supabase
        .from('leads')
        .select('*, customers(*), quotes(*)')
        .eq('business_id', business.id)
        .order('created_at', { ascending: false });
      
      // סנן רק פניות עם הצעות שנשלחו או אושרו
      const readyLeads = leadsWithQuotes?.filter(lead => 
        lead.quotes?.some(quote => ['approved', 'sent'].includes(quote.status))
      ) || [];
      
      if (readyLeads.length === 0) {
        await sendWhatsAppMessage(business, normalizedOwner, 
          '❌ לא נמצאו פניות עם הצעות מאושרות שממתינות לתיאום פגישה.\n\nתאשר קודם הצעת מחיר ללקוח.');
        return;
      }
      
      // אם יש כמה פניות - עבור אוטומטית לפי הסדר (הישנה ביותר קודם)
      if (readyLeads.length > 1) {
        console.log(`📋 נמצאו ${readyLeads.length} פניות מוכנות לתיאום - עובר לישנה ביותר`);
        
        // מיין לפי תאריך יצירה (הישנה ראשונה)
        readyLeads.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        
        const lead = readyLeads[0];
        const leadNumber = lead.notes?.match(/\d{4}/)?.[0] || lead.id.substring(0,8);
        
        await sendWhatsAppMessage(business, normalizedOwner,
          `📋 *מתחיל תיאום פגישה לפנייה #${leadNumber}*\n\n` +
          `👤 ${lead.customers.name}\n` +
          `📍 ${lead.customers.address}\n\n` +
          `➡️ יש עוד ${readyLeads.length - 1} פניות ממתינות שיטופלו לאחר מכן`);
        
        // סמן את הפנייה כנוכחית
        await supabase
          .from('businesses')
          .update({ 
            settings: {
              ...business.settings,
              current_scheduling_lead: lead.id,
              pending_scheduling_leads: readyLeads.slice(1).map(l => l.id)
            }
          })
          .eq('id', business.id);
        
        // התחל תיאום
        await startAppointmentScheduling(business, lead, lead.customers, normalizedOwner);
        return;
      }
      
      // יש פנייה אחת - התחל תיאום
      const lead = readyLeads[0];
      const customer = lead.customers;
      
      // חשב זמנים פנויים
      await startAppointmentScheduling(business, lead, customer, normalizedOwner);
      return;
    }
    
    if (messageText.toLowerCase().includes('עריכה')) {
      console.log('✏️ בעל העסק רוצה לערוך הצעה');
      await sendWhatsAppMessage(business, normalizedOwner, 
        '✏️ *עריכת הצעה*\n\nאפשר לבחור מוצרים מחדש.\nשלח את מספרי המוצרים החדשים מופרדים בפסיקים.');
      
      // חזור לשלב בחירת מוצרים
      const { data: lastQuote } = await supabase
        .from('quotes')
        .select('lead_id')
        .eq('status', 'pending_owner_approval')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      
      if (lastQuote) {
        await supabase
          .from('quotes')
          .delete()
          .eq('lead_id', lastQuote.lead_id)
          .eq('status', 'pending_owner_approval');
      }
      return;
    }
    
    if (messageText.toLowerCase().includes('ביטול')) {
        console.log('❌ בעל העסק ביטל הוספת מוצרים');
        // החזר למצב עריכה רגיל
        await supabase
          .from('quotes')
          .update({ notes: '[WAITING_FOR_EDIT_CHOICE]' })
          .eq('id', editQuote.id);
        
        // הצג הצעה מעודכנת
        await showUpdatedQuote(business, editQuote.id, normalizedOwner);
      return;
    }
    
    // בדוק אם בעל העסק שולח "5" לאישור הצעה
    if (messageText.trim() === '5') {
      // נסה למצוא הצעה פעילה
      const { data: activeQuote } = await supabase
        .from('quotes')
        .select('*, quote_items(*, products(*))')
        .eq('status', 'pending_owner_approval')
        .eq('business_id', business.id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (activeQuote) {
        console.log('✅ בעל העסק אישר הצעה (מחוץ למצב עריכה)');
        await handleOwnerApproval(business, activeQuote.id);
        return;
      }
    }
    
    // אם לא זיהינו את הפקודה - שלח הנחיות
    console.log('❓ הודעה לא מזוהה מבעל העסק');
    
    // בדוק אם יש פנייה שממתינה לפעולה
    if (pendingLead) {
      await sendWhatsAppMessage(business, normalizedOwner, 
        `❓ לא הבנתי את הבקשה.\n\nאנא בחר אחת מהאפשרויות:\n\n1️⃣ צור הצעת מחיר\n2️⃣ נעבוד בהמשך\n3️⃣ פתח טופס קשר\n4️⃣ פתח WhatsApp\n\nהשב עם המספר בלבד (1-4)`);
    } else {
      // בדוק אם יש פנייה שממתינה לבחירת מוצרים
      const { data: quoteLead } = await supabase
        .from('leads')
        .select('*')
        .eq('business_id', business.id)
        .eq('status', 'new')
        .like('notes', '%Waiting for quote selection%')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      
      if (quoteLead) {
        await sendWhatsAppMessage(business, normalizedOwner, 
          `❓ לא הבנתי.\n\nכדי ליצור הצעת מחיר, שלח את מספרי המוצרים מופרדים בפסיקים.\n*דוגמה:* 1,3,5\n\nאו שלח *"ביטול"* לביטול התהליך.`);
      } else {
        await sendWhatsAppMessage(business, normalizedOwner, 
          `👋 שלום!\n\nאני הבוט האוטומטי של המערכת.\nאני מטפל בפניות לקוחות ומעביר אליך סיכומים.\n\nכרגע אין פניות פתוחות שדורשות טיפול.`);
      }
    }
    return;
  }
  // 1. בדוק אם הלקוח קיים (אם לא נבדק כבר)
  if (!customer) {
    customer = await findCustomer(business.id, phoneNumber);
  }

  if (!customer) {
    console.log('🆕 לקוח חדש - יוצר...');
    customer = await createCustomer(business.id, phoneNumber);
  } else {
    console.log(`✅ לקוח קיים: ${customer.name}`);
  }
  
  // בדיקה מהירה: האם הלקוח באמצע תהליך תשובה?
  if (customer.notes && (customer.notes.includes('[WAITING_FOR_RELATED_LEAD_ANSWER]') || 
      customer.notes.includes('[WAITING_FOR_GENERAL_CORRESPONDENCE]'))) {
    console.log('🔔 הלקוח באמצע תהליך תשובה - עוברים לטיפול ישיר');
    // הקוד ימשיך למטה לבדיקות הרלוונטיות
  }

// 2. נתח את ההודעה עם Claude AI
// בנה היסטוריה של השיחה (פשוט לעכשיו)
const conversationHistory = [];
if (customer.notes) {
  conversationHistory.push(`הערות קודמות: ${customer.notes}`);
}

// שלח את פרטי הלקוח ל-Claude
const analysis = await analyzeMessageWithClaude(
  messageText, 
  conversationHistory,
  {
    name: customer.name,
    address: customer.address,
    city: customer.city
  }
);

// אם זו לא פנייה עסקית - אל תגיב בכלל
if (!analysis.is_business_inquiry) {
  console.log('💬 שיחה פרטית - הבוט לא מגיב');
  return; // צא בלי לשלוח כלום
}
  
// ========================================
// 🆕 זיהוי חכם של פרטי לקוח
// ========================================

  // בדיקה אם זו תשובה לשאלה על השם
if (customer.notes && customer.notes.includes('[WAITING_FOR_NAME]')) {
  console.log(`📝 קיבלתי שם: ${messageText}`);
  
  await supabase
    .from('customers')
    .update({ 
      name: messageText.trim(),
      notes: customer.notes.replace('[WAITING_FOR_NAME]', '[WAITING_FOR_DESCRIPTION]')
    })
    .eq('id', customer.id);
  
  customer.name = messageText.trim();
  console.log(`✅ שם עודכן ל: ${customer.name}`);
  
  // עכשיו בקש תיאור הבעיה
  const response = `נעים מאוד ${customer.name}! 😊\n\nאיך אוכל לעזור לך היום?\nתאר/י בקצרה את הבעיה או השירות שאתה צריך.`;
  await sendWhatsAppMessage(business, phoneNumber, response);
  return;
}

// בדיקה אם זו תשובה לתיאור הבעיה
if (customer.notes && customer.notes.includes('[WAITING_FOR_DESCRIPTION]')) {
  console.log(`📝 קיבלתי תיאור בעיה: ${messageText}`);
  
  // שמור את התיאור ב-notes
  await supabase
    .from('customers')
    .update({ 
      notes: customer.notes.replace('[WAITING_FOR_DESCRIPTION]', `תיאור: ${messageText}\n[WAITING_FOR_ADDRESS]`)
    })
    .eq('id', customer.id);
  
  // בקש כתובת
  const response = `תודה על הפירוט ${customer.name}! 📝\n\nכדי שאוכל להכין הצעת מחיר מדויקת, מה הכתובת שלך?\n(רחוב, מספר ועיר)`;
  await sendWhatsAppMessage(business, phoneNumber, response);
  return;
}

// בדיקה אם זו תשובה לכתובת
if (customer.notes && customer.notes.includes('[WAITING_FOR_ADDRESS]')) {
  console.log(`📍 קיבלתי כתובת: ${messageText}`);
  
  // חלץ עיר אם יש
  const cities = ['תל אביב', 'ירושלים', 'חיפה', 'ראשון לציון', 'פתח תקווה', 
                  'אשדוד', 'נתניה', 'באר שבע', 'בני ברק', 'רמת גן',
                  'רמת השרון', 'הרצליה', 'רעננה', 'כפר סבא', 'קריית אתא'];
  
  let foundCity = null;
  for (const city of cities) {
    if (messageText.toLowerCase().includes(city.toLowerCase())) {
      foundCity = city;
      break;
    }
  }
  
  await supabase
    .from('customers')
    .update({ 
      address: messageText.trim(),
      city: foundCity,
      notes: customer.notes.replace('[WAITING_FOR_ADDRESS]', `[WAITING_FOR_PHOTO]`)
    })
    .eq('id', customer.id);
  
  
  customer.address = messageText.trim();
  customer.city = foundCity;
  console.log(`✅ כתובת עודכנה! עיר: ${foundCity}`);
  
  // בקש תמונה
  const response = `מצוין! 📍\n\nעכשיו, כדי שאוכל להכין הצעת מחיר מדויקת, אשמח אם תוכל/י לשלוח:\n📷 תמונות של הבעיה (עד 4 תמונות)\n🎥 או וידאו קצר\n\nזה יעזור לי להבין בדיוק מה צריך ולתת לך מחיר הוגן! 😊`;
  await sendWhatsAppMessage(business, phoneNumber, response);
  
  // שמור שמחכים לתמונות עם מונה
  await supabase
    .from('customers')
    .update({ 
      notes: customer.notes.replace('[WAITING_FOR_ADDRESS]', '[WAITING_FOR_PHOTOS]|COUNT:0')
    })
    .eq('id', customer.id);
  return;
}

// בדיקה 4: האם הלקוח ממתין לאישור כתובת?
if (customer.notes && customer.notes.includes('[WAITING_FOR_ADDRESS_CONFIRMATION]')) {
  console.log('📍 הלקוח באישור כתובת');
  
  const lowerMessage = messageText.toLowerCase();
  if (lowerMessage === 'כן' || lowerMessage === 'yes' || lowerMessage === 'נכון') {
    // הכתובת נכונה - המשך לשאלת תיאור
    await supabase
      .from('customers')
      .update({ notes: '[WAITING_FOR_DESCRIPTION]' })
      .eq('id', customer.id);
    
    await sendWhatsAppMessage(business, phoneNumber, 
      `מצוין! 📋\n\nאיך אוכל לעזור לך היום?`);
    return;
  } else {
    // כתובת חדשה - עדכן
    const addressMatch = messageText.match(/(.+)/);
    if (addressMatch && messageText.length > 5) {
      const newAddress = addressMatch[1].trim();
      
      // נסה לזהות עיר
      let city = '';
      const cityPatterns = [
        /ב?תל[\s-]?אביב/i, /ב?רמת[\s-]?גן/i, /ב?ירושלים/i, /ב?חיפה/i,
        /ב?פתח[\s-]?תקו?ה/i, /ב?ראשון[\s-]?לציון/i, /ב?נתניה/i,
        /ב?רמת[\s-]?השרון/i, /ב?הרצליה/i, /ב?כפר[\s-]?סבא/i,
        /ב?רעננה/i, /ב?רחובות/i, /ב?אשדוד/i, /ב?באר[\s-]?שבע/i
      ];
      
      for (const pattern of cityPatterns) {
        const match = newAddress.match(pattern);
        if (match) {
          city = match[0].replace(/^ב/, '').trim();
          break;
        }
      }
      
      await supabase
        .from('customers')
        .update({ 
          address: newAddress,
          city: city || customer.city,
          notes: '[WAITING_FOR_DESCRIPTION]' 
        })
        .eq('id', customer.id);
      
      await sendWhatsAppMessage(business, phoneNumber, 
        `תודה! עדכנתי את הכתובת ל: ${newAddress} ✅\n\nאיך אוכל לעזור לך היום?`);
      return;
    } else {
      await sendWhatsAppMessage(business, phoneNumber, 
        `לא הבנתי את הכתובת החדשה.\nאנא שלח/י כתובת מלאה (רחוב, מספר ועיר)`);
      return;
    }
  }
}

// בדיקה 5: האם הלקוח בהתכתבות כללית?
if (customer.notes && customer.notes.includes('[WAITING_FOR_GENERAL_CORRESPONDENCE]')) {
  console.log('💬 הלקוח בהתכתבות כללית');
  
  const lowerMessage = messageText.toLowerCase();
  const leadIdMatch = customer.notes.match(/LEAD:([a-f0-9-]+)/);
  const relatedLeadId = leadIdMatch ? leadIdMatch[1] : null;
  const originalMsgMatch = customer.notes.match(/MSG:(.+)$/);
  const originalMessage = originalMsgMatch ? originalMsgMatch[1] : '';
  
  if (lowerMessage === 'כן' || lowerMessage === 'yes') {
    // התכתבות כללית - הפסק מענה ל-24 שעות
    await sendWhatsAppMessage(business, phoneNumber,
      `תודה ${customer.name}! 📨\n\n` +
      `העברתי את ההודעה שלך לבעל העסק.\n` +
      `הוא יחזור אליך בהמשך היום.\n\n` +
      `🔕 לא אשלח הודעות אוטומטיות ב-24 השעות הקרובות כדי לאפשר לכם להתכתב בחופשיות.`);
    
    // שמור סימון של התכתבות כללית
    await supabase
      .from('customers')
      .update({ notes: `[GENERAL_CORRESPONDENCE_24H]|UNTIL:${new Date(Date.now() + 24*60*60*1000).toISOString()}` })
      .eq('id', customer.id);
    
    // שלח את ההודעה המקורית לבעל העסק
    if (relatedLeadId) {
      const { data: relatedLead } = await supabase
        .from('leads')
        .select('*')
        .eq('id', relatedLeadId)
        .single();
      
      if (relatedLead) {
        const leadNumber = relatedLead.notes?.match(/\d{4}/)?.[0] || relatedLead.id.substring(0,8);
        
        await sendWhatsAppMessage(business, normalizePhone(business.owner_phone),
          `💬 *הודעה מלקוח - פנייה #${leadNumber}*\n\n` +
          `👤 ${customer.name}\n` +
          `📱 ${customer.phone}\n\n` +
          `💬 ההודעה: "${originalMessage}"\n\n` +
          `🔕 הבוט לא יענה ללקוח ב-24 השעות הקרובות`);
      }
    }
    return;
  }
  
  // לא התכתבות כללית - עבור לפנייה רגילה
  await supabase
    .from('customers')
    .update({ notes: '[WAITING_FOR_DESCRIPTION]' })
    .eq('id', customer.id);
  
  await sendWhatsAppMessage(business, phoneNumber, 
    `בסדר! איך אוכל לעזור לך? 😊`);
  return;
}

// בדיקה 6: האם הלקוח ממתין לתשובה על פנייה קשורה?
if (customer.notes && customer.notes.includes('[WAITING_FOR_RELATED_LEAD_ANSWER]')) {
  console.log('🔗 הלקוח בבדיקת פנייה קשורה');
  
  const lowerMessage = messageText.toLowerCase();
  const leadIdMatch = customer.notes.match(/LEAD:([a-f0-9-]+)/);
  const relatedLeadId = leadIdMatch ? leadIdMatch[1] : null;
  
  if (lowerMessage === 'כן' || lowerMessage === 'yes') {
    // זו התכתבות על פנייה קיימת - שלח תזכורת לבעל העסק
    if (relatedLeadId) {
      const { data: relatedLead } = await supabase
        .from('leads')
        .select('*, quotes(*)')
        .eq('id', relatedLeadId)
        .single();
      
      if (relatedLead) {
        const leadNumber = relatedLead.notes?.match(/\d{4}/)?.[0] || relatedLead.id.substring(0,8);
        
        await sendWhatsAppMessage(business, normalizePhone(business.owner_phone),
          `⏰ *תזכורת - פנייה #${leadNumber}*\n\n` +
          `👤 ${customer.name}\n` +
          `📱 ${customer.phone}\n` +
          `💬 הלקוח שלח הודעה בנוגע להצעה המאושרת\n\n` +
          `📋 הודעה: "${messageText}"\n\n` +
          `✅ ההצעה אושרה ב: ${new Date(relatedLead.quotes[0].approved_at).toLocaleDateString('he-IL')}\n\n` +
          `🔔 *נא לתאם פגישה עם הלקוח*`);
        
        await sendWhatsAppMessage(business, phoneNumber,
          `תודה ${customer.name}! 📨\n\n` +
          `שלחתי תזכורת ל${business.owner_name || 'בעל העסק'}.\n` +
          `הוא יצור איתך קשר בקרוב לתיאום הפגישה.\n\n` +
          `בינתיים, אני כאן אם יש לך שאלות נוספות 😊`);
        
        // נקה את ה-notes
        await supabase
          .from('customers')
          .update({ notes: '' })
          .eq('id', customer.id);
        return;
      }
    }
  }
  
  // לא קשור - המשך לפנייה חדשה
  await supabase
    .from('customers')
    .update({ notes: '[WAITING_FOR_DESCRIPTION]' })
    .eq('id', customer.id);
  
  await sendWhatsAppMessage(business, phoneNumber, 
    `בסדר, אפתח פנייה חדשה 📋\n\nאיך אוכל לעזור לך היום?`);
  return;
}

// בדיקה 6.5: האם הלקוח ממתין לשליחת כתובת מלאה לתיאום פגישה?
if (customer && customer.notes && customer.notes.includes('[WAITING_FOR_ADDRESS_FOR_APPOINTMENT]')) {
  console.log('📍 הלקוח שולח כתובת מלאה לתיאום פגישה');
  
  const leadIdMatch = customer.notes.match(/LEAD:([a-f0-9-]+)/);
  const leadId = leadIdMatch ? leadIdMatch[1] : null;
  
  if (leadId) {
    const { data: lead } = await supabase
      .from('leads')
      .select('*, businesses(*)')
      .eq('id', leadId)
      .single();
    
    if (lead) {
      const business = lead.businesses;
      
      // עדכן את הכתובת המלאה
      await supabase
        .from('customers')
        .update({ 
          full_address: messageText.trim(),
          notes: '' 
        })
        .eq('id', customer.id);
      
      await sendWhatsAppMessage(business, phoneNumber,
        `תודה! קיבלתי את הכתובת 📍\n\nבעל העסק ממשיך בתיאום הפגישה...`
      );
      
      // המשך בתיאום פגישה
      await startAppointmentScheduling(business, lead, customer, normalizePhone(business.owner_phone));
    }
  }
  console.log('🔚 Returning after address handling');
  return;
}

// הקוד של בדיקת בחירת פגישה הועבר למעלה בתחילת הבדיקות

// בדיקה 7: אם זו תשובה לבקשת תמונות (תומך במספר תמונות)
if (customer && customer.notes && (customer.notes.includes('[WAITING_FOR_PHOTO]') || customer.notes.includes('[WAITING_FOR_PHOTOS]'))) {
  console.log('📷 הלקוח באמצע תהליך - ממתין לתמונות');
  
  // טען מחדש את הלקוח כדי לקבל את ה-notes העדכני
  const { data: updatedCustomer } = await supabase
    .from('customers')
    .select('*')
    .eq('id', customer.id)
    .single();
  
  if (updatedCustomer) {
    customer = updatedCustomer;
  }
  
  // בדוק כמה תמונות כבר קיבלנו
  let photoCount = 0;
  const countMatch = customer.notes.match(/COUNT:(\d+)/);
  if (countMatch) {
    photoCount = parseInt(countMatch[1]);
  }
  
  if (mediaUrl) {
    photoCount++;
    console.log(`📸 קיבלנו תמונה מספר ${photoCount}`);
    
    // שמור את המדיה מיד
    let tempLeadId = customer.notes?.match(/TEMP_LEAD:([a-f0-9-]+)/)?.[1];
    
    if (!tempLeadId) {
      // חלץ את תיאור הבעיה אם קיים
      let tempDescription = 'פנייה בתהליך';
      if (customer.notes && customer.notes.includes('תיאור:')) {
        const descMatch = customer.notes.match(/תיאור: ([^\n]+)/);
        if (descMatch) {
          tempDescription = descMatch[1];
        }
      }
      
      // צור Lead זמני אם עוד אין
      const tempLead = await createLead(business.id, customer.id, tempDescription, analysis);
      tempLeadId = tempLead.id;
      console.log(`🆕 נוצר Lead זמני: ${tempLeadId} עם תיאור: ${tempDescription}`);
      
      // עדכן את ה-notes עם ה-Lead ID
      const updatedNotes = customer.notes + `|TEMP_LEAD:${tempLeadId}`;
      await supabase
        .from('customers')
        .update({ notes: updatedNotes })
        .eq('id', customer.id);
      
      // עדכן גם את האובייקט המקומי
      customer.notes = updatedNotes;
    }
    
    // שמור את המדיה
    if (tempLeadId) {
      console.log(`💾 שומר מדיה ל-Lead: ${tempLeadId}`);
      await saveMedia(tempLeadId, mediaUrl, mediaType, `תמונה ${photoCount}`);
    }
    
    if (photoCount < 4) {
      // עדכן את המונה ושאל אם יש עוד
      const updatedNotes = customer.notes.replace(/COUNT:\d+/, `COUNT:${photoCount}`);
      await supabase
        .from('customers')
        .update({ 
          notes: updatedNotes
        })
        .eq('id', customer.id);
      
      // עדכן גם את האובייקט המקומי
      customer.notes = updatedNotes;
      
      await sendWhatsAppMessage(business, phoneNumber, 
        `✅ קיבלתי תמונה ${photoCount} מתוך 4\n\n` +
        `יש עוד תמונות לשלוח?\n` +
        `▫️ כן - שלח/י אותן\n` +
        `▫️ לא - נמשיך להצעת מחיר`);
      return;
    }
  }
  
  // קיבלנו 4 תמונות או הלקוח אמר שאין עוד
  if (photoCount >= 4 || (messageText.toLowerCase() === 'לא' || messageText.toLowerCase() === 'אין')) {
    console.log(`✅ סיימנו לקבל תמונות - סה"כ ${photoCount} תמונות`);
    
    // חלץ את ה-Lead ID מה-notes
    const tempLeadId = customer.notes?.match(/TEMP_LEAD:([a-f0-9-]+)/)?.[1];
    
    // נקה את הסימון
    await supabase
      .from('customers')
      .update({ 
        notes: ''
      })
      .eq('id', customer.id);
    
    // אם יש Lead זמני - עדכן אותו ושלח לבעל העסק
    if (tempLeadId) {
      const { data: lead } = await supabase
        .from('leads')
        .select('*, customers(*)')
        .eq('id', tempLeadId)
        .single();
        
      if (lead) {
        // שלח אישור ללקוח
        await sendWhatsAppMessage(business, phoneNumber,
          `מצוין ${customer.name}! קיבלתי את כל הפרטים 📋\n\n` +
          `✅ תיאור הבעיה\n` +
          `✅ כתובת: ${customer.address}\n` +
          `✅ ${photoCount} תמונות/סרטונים\n\n` +
          `אני מעביר את הפנייה ל${business.owner_name || 'בעל העסק'} להכנת הצעת מחיר.\n\n` +
          `נחזור אליך בהקדם! 🚀`);
          
        // שלח לבעל העסק
        await sendCompleteSummaryToOwner(business, customer, lead);
        return;
      }
    }
    
    // המשך ליצירת Lead עם כל הפרטים
    customer.notes = ''; // נקה כדי שלא יפריע בהמשך
  } else if (messageText.toLowerCase() === 'כן' && photoCount > 0) {
    // הלקוח רוצה לשלוח עוד תמונות
    await sendWhatsAppMessage(business, phoneNumber, 
      `👍 בסדר, שלח/י את התמונות הנוספות (עד ${4 - photoCount} תמונות נוספות)`);
    return;
  }
  
  // דלג על כל הבדיקות האחרות וישר לך ליצירת Lead
} else if (analysis.is_business_inquiry) {
  // רק אם זו לא תגובה לבקשת תמונה - בדוק פרטים חסרים
  
  // בדיקה 8: זיהוי מפורש (אם לקוח כותב "שמי...")
const nameMatch = messageText.match(/שמי\s+(.+)|קוראים לי\s+(.+)|אני\s+(.+)|השם שלי\s+(.+)/i);
if (nameMatch) {
  const name = (nameMatch[1] || nameMatch[2] || nameMatch[3] || nameMatch[4]).trim();
  console.log(`📝 זיהוי שם מפורש: ${name}`);
  
  await supabase
    .from('customers')
    .update({ name: name })
    .eq('id', customer.id);
  
  customer.name = name;
  console.log(`✅ שם עודכן ל: ${name}`);
}

// ========================================
// ✅ בדיקת פרטים לפני יצירת Lead
// ========================================

  // קודם בדוק אם יש פנייה אחרונה עם הצעה מאושרת
  const { data: recentApprovedLead } = await supabase
    .from('leads')
    .select('*, quotes(*)')
    .eq('customer_id', customer.id)
    .eq('business_id', business.id)
    .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()) // 30 ימים אחרונים
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  
  if (recentApprovedLead && recentApprovedLead.quotes && recentApprovedLead.quotes.length > 0) {
    const approvedQuote = recentApprovedLead.quotes.find(q => q.status === 'approved');
    if (approvedQuote) {
      // יש הצעה מאושרת - שאל אם זה בקשר אליה
      await sendWhatsAppMessage(business, phoneNumber,
        `שלום ${customer.name}! 👋\n\nאני רואה שיש לך הצעת מחיר מאושרת #${recentApprovedLead.notes?.match(/\d{4}/)?.[0] || recentApprovedLead.id.substring(0,8)}\n\n` +
        `האם הפנייה הנוכחית קשורה להצעה זו?\n\n` +
        `▫️ כן - אשלח תזכורת לבעל העסק\n` +
        `▫️ לא - אפתח פנייה חדשה`);
      
      // שמור מצב המתנה לתשובה
      await supabase
        .from('customers')
        .update({ notes: `[WAITING_FOR_RELATED_LEAD_ANSWER]|LEAD:${recentApprovedLead.id}` })
        .eq('id', customer.id);
      return;
    }
  }
  
  // לקוח חדש - אין שם
  if (!customer.name || customer.name.startsWith('לקוח ')) {
    // שמור שמחכים לשם
    await supabase
      .from('customers')
      .update({ notes: '[WAITING_FOR_NAME]' })
      .eq('id', customer.id);
    
    const response = 'שלום! אני עוזר אישי   😊\n מבקש לעקוב אחרי ההנחיות \n איך קוראים לך?';
    await sendWhatsAppMessage(business, phoneNumber, response);
    return;
  }
  
  // לקוח קיים - יש שם אבל אין כתובת
  if (!customer.address) {
    const response = `שלום ${customer.name}! שמחים לשמוע ממך שוב 👋\n\nכדי שאוכל להכין לך הצעת מחיר מדויקת, מה הכתובת שלך?\n(רחוב, מספר ועיר)`;
    await sendWhatsAppMessage(business, phoneNumber, response);
    return;
  }
  
  // לקוח קיים עם כתובת - הצג את הכתובת ובקש אישור
  const currentAddress = `${customer.address}${customer.city ? `, ${customer.city}` : ''}`;
  await sendWhatsAppMessage(business, phoneNumber,
    `שלום ${customer.name}! שמח לשמוע ממך שוב 😊\n\n` +
    `הכתובת שרשומה אצלי: ${currentAddress}\n\n` +
    `האם זו הכתובת הנכונה לפנייה הנוכחית?\n` +
    `▫️ כן - נמשיך\n` +
    `▫️ לא - אנא שלח/י את הכתובת החדשה`);
  
  // שמור מצב המתנה לאישור כתובת
  await supabase
    .from('customers')
    .update({ notes: '[WAITING_FOR_ADDRESS_CONFIRMATION]' })
    .eq('id', customer.id);
  return;
}

// ========================================
  // 3. בדוק אם יש פנייה פתוחה
  // ========================================
// בדוק אם יש פנייה פתוחה או lead זמני מהתמונות
  let lead = await findOpenLead(customer.id);

// אם יש TEMP_LEAD בהערות, השתמש בו
const tempLeadMatch = customer.notes?.match(/TEMP_LEAD:([a-f0-9-]+)/);
if (!lead && tempLeadMatch) {
  const { data: tempLead } = await supabase
    .from('leads')
    .select('*')
    .eq('id', tempLeadMatch[1])
    .single();
  if (tempLead) {
    lead = tempLead;
    console.log(`📋 משתמש ב-Lead זמני: ${lead.id}`);
  }
}

if (lead) {
  console.log(`📋 פנייה נמצאה: ${lead.id}`);
  console.log(`📋 מצב (notes): ${lead.notes || 'ללא מצב'}`);
}

  if (!lead) {
    // ========================================
    // 🆕 פנייה חדשה - צור אותה
    // ========================================
    console.log('🆕 פנייה עסקית חדשה - יוצר...');
    
    // בדוק אם יש Lead זמני עם מדיה
    let tempLeadId = null;
    const tempLeadMatch = customer.notes?.match(/TEMP_LEAD:([a-f0-9-]+)/);
    if (tempLeadMatch) {
      tempLeadId = tempLeadMatch[1];
      console.log(`🔄 מצאתי Lead זמני: ${tempLeadId}`);
    }
    
    // שמור את תיאור הבעיה מה-notes של הלקוח
    let problemDescription = messageText;
    if (customer.notes && customer.notes.includes('תיאור:')) {
      const descMatch = customer.notes.match(/תיאור: ([^\n]+)/);
      if (descMatch) {
        problemDescription = descMatch[1];
        console.log(`📝 נמצא תיאור בעיה: ${problemDescription}`);
      }
    }
    
    // אם יש lead זמני, השתמש בו כבסיס
    if (tempLeadId) {
      // עדכן את ה-lead הזמני למצב סופי
      const leadNumber = await getNextLeadNumber(business.id);
      const { data: updatedLead } = await supabase
        .from('leads')
        .update({ 
          service_description: problemDescription,
          status: 'new',
          notes: `פנייה #${leadNumber}`
        })
        .eq('id', tempLeadId)
        .select()
        .single();
      
      lead = updatedLead || { id: tempLeadId };
      console.log(`✅ Lead זמני הפך לפנייה סופית עם תיאור: ${problemDescription}`);
    } else {
      // צור lead חדש
      lead = await createLead(business.id, customer.id, problemDescription, analysis);
    }

    // אם יש מדיה חדשה - שמור אותה
    if (mediaUrl && mediaType) {
      await saveMedia(lead.id, mediaUrl, mediaType, messageText);
    }
    // בדוק כמה תמונות יש
    console.log(`🔍 בודק מדיה עבור lead.id: ${lead.id}`);
    console.log(`📋 מצב (notes): ${lead.notes || 'אין'}`);
    const { data: allMedia, error: mediaError } = await supabase
      .from('lead_media')
      .select('*')
      .eq('lead_id', lead.id);

    if (mediaError) {
      console.error(`❌ שגיאה בשליפת מדיה:`, mediaError);
    }

    const mediaCount = allMedia ? allMedia.length : 0;
    console.log(`📸 סה"כ מדיה בפנייה: ${mediaCount} קבצים`);
    if (allMedia && allMedia.length > 0) {
      console.log(`📸 פירוט מדיה:`, allMedia.map(m => ({
        type: m.media_type,
        file: m.file_path,
        caption: m.caption
      })));
    }

    // סיכום ללקוח ושליחה לבעל העסק
    const summaryMessage = `מצוין ${customer.name}! קיבלתי את כל הפרטים 📋\n\n✅ הבעיה: ${lead.service_description || messageText}\n✅ כתובת: ${customer.address}${customer.city ? `, ${customer.city}` : ''}\n${mediaCount > 0 ? `✅ ${mediaCount} תמונות/וידאו` : ''}\n\nאני מעביר את הפנייה שלך ל-${business.owner_name || 'בעל העסק'} להכנת הצעת מחיר.\n\nנחזור אליך בהקדם! 🚀`;

    await sendWhatsAppMessage(business, phoneNumber, summaryMessage);

    // נקה את notes של הלקוח מכל סימוני TEMP_LEAD
    if (customer.notes && customer.notes.includes('TEMP_LEAD')) {
      await supabase
        .from('customers')
        .update({ notes: '' })
        .eq('id', customer.id);
    }

    // שלח ישר לבעל העסק
    await sendCompleteSummaryToOwner(business, customer, lead);
    return; // סיום הטיפול בפנייה חדשה
}

  // ========================================
  // ✅ פנייה קיימת - תהליך שלב-שלב
  // ========================================
  console.log(`✅ פנייה קיימת: ${lead.id}`);
  console.log(`📋 מצב פנייה: ${lead.notes || 'ללא מצב'}`);


  // בדוק אם קיבלנו מדיה
  if (mediaUrl && mediaType) {
    console.log('💾 שומר מדיה...');
    await saveMedia(lead.id, mediaUrl, mediaType, messageText);
  }

  // עדכן את תיאור הפנייה עם המידע החדש
  const updatedDescription = (lead.service_description || '') + '\n' + messageText;
  await updateLeadDescription(lead.id, updatedDescription);

  // בדוק מה כבר יש ומה חסר
  const hasDescription = lead.service_description && lead.service_description.trim().length > 0;
  const hasDetailedDescription = lead.service_description && lead.service_description.length > 50;
  
  const { data: existingMedia } = await supabase
    .from('lead_media')
    .select('id')
    .eq('lead_id', lead.id)
    .limit(1);
  
  const hasMedia = existingMedia && existingMedia.length > 0;
  
  console.log(`📊 סטטוס: תיאור=${hasDescription}, תיאור_מפורט=${hasDetailedDescription}, כתובת=${!!customer.address}, מדיה=${hasMedia}, מדיה_חדשה=${!!mediaUrl}`);

  // אם יש תיאור בסיסי + מדיה, זה מספיק - אל תבקש עוד פרטים
  if (hasDescription && hasMedia) {
    console.log('✅ יש תיאור ומדיה - לא צריך לבקש עוד פרטים');
    await sendCompleteSummaryToOwner(business, customer, lead);
    return;
  }

  // ========================================
  // שלב 1: אין תיאור כלל - בקש תיאור
  // ========================================
  if (!hasDescription && !mediaUrl) {
    console.log('📝 שלב 1: מבקש תיאור מפורט...');
    
    const response = `תודה ${customer.name}! 

כדי שאוכל להכין הצעת מחיר מדויקת, אשמח לקבל עוד כמה פרטים:

🔧 מה בדיוק הבעיה?
⏰ מתי זה קרה?
❓ האם זה קרה פתאום או בהדרגה?

תאר/י בכמה מילים מה קורה 😊`;
    
    await sendWhatsAppMessage(business, phoneNumber, response);
    return; // חכה לתיאור
  }

  // ========================================
  // שלב 2: יש תיאור, אבל אין כתובת - בקש כתובת
  // ========================================
  if (!customer.address || customer.address.trim() === '') {
    console.log('📍 שלב 2: מבקש כתובת...');
    
    const response = `מעולה ${customer.name}! קיבלתי את התיאור 👍

כדי שאוכל לתאם הגעה ולתת הצעת מחיר מדויקת, אשמח לקבל:

📍 כתובת מלאה (רחוב, מספר בית, עיר)
🏢 קומה/דירה (אם רלוונטי)

לדוגמה: רימון 8 רמת אפעל, קומה 2`;
    
    await sendWhatsAppMessage(business, phoneNumber, response);
    return; // חכה לכתובת
  }

  // ========================================
  // שלב 3: יש תיאור וכתובת, אבל אין מדיה - בקש תמונה
  // ========================================
  if (!hasMedia && !mediaUrl) {
    console.log('📸 שלב 3: מבקש תמונה/וידאו...');
    
    const response = `תודה על הכתובת ${customer.name}! 

עכשיו, כדי שאוכל להכין הצעת מחיר מדויקת, אשמח אם תוכל/י לשלוח:

📷 תמונה של הבעיה
🎥 או וידאו קצר (עד 30 שניות)

זה יעזור לי להבין בדיוק מה צריך ולתת לך מחיר הוגן! 😊`;
    
    await sendWhatsAppMessage(business, phoneNumber, response);
    return; // חכה לתמונה
  }

  // ========================================
  // שלב 4: אם הגיעה מדיה עכשיו - שמור אותה
  // ========================================
  if (mediaUrl && mediaType && !hasMedia) {
    console.log('💾 שומר מדיה...');
    await saveMedia(lead.id, mediaUrl, mediaType, messageText);
    
    // אם זו המדיה הראשונה - הודע ללקוח
      const response = `מצוין ${customer.name}! 🎉

קיבלתי:
✅ תיאור הבעיה
✅ ${mediaType === 'image' ? 'תמונה' : 
    mediaType === 'video' ? 'וידאו' : 
    mediaType === 'audio' ? 'הודעה קולית' : 'קובץ'}

אני מכין לך הצעת מחיר מדויקת ואחזור אליך תוך מספר שעות.

תודה על הסבלנות! 😊`;
      
      await sendWhatsAppMessage(business, phoneNumber, response);
  }

  // ========================================
  // שלב 5: יש הכל - שלח לבעל העסק
  // ========================================
  if ((hasDescription || hasDetailedDescription) && (hasMedia || mediaUrl)) {
    console.log('📝 יש את כל הפרטים - שולח לבעל העסק...');
    
    const confirmationMessage = `${customer.name}, קיבלתי את כל הפרטים! 📋

אני מעביר את הפנייה שלך ל-${business.owner_name || 'בעל העסק'} להכנת הצעת מחיר.

נחזור אליך בהקדם! 🚀`;
    
    await sendWhatsAppMessage(business, phoneNumber, confirmationMessage);
    
    // שלח ישר לבעל העסק
      await sendCompleteSummaryToOwner(business, customer, lead);
    return;
  }
}

// ========================================
// 📋 הצג הצעה מעודכנת
// ========================================
async function showPendingLeads(business, ownerPhone) {
  try {
    // מצא את כל הפניות הממתינות
    const { data: pendingLeads } = await supabase
      .from('leads')
      .select('*, customers(*)')
      .eq('business_id', business.id)
      .eq('status', 'new')
      .order('created_at', { ascending: false });
    
    if (!pendingLeads || pendingLeads.length === 0) {
      await sendWhatsAppMessage(business, ownerPhone,
        '📭 אין פניות ממתינות כרגע.');
      return;
    }
    
    let message = '📋 *פניות ממתינות:*\n\n';
    pendingLeads.forEach(lead => {
      const leadNumber = lead.notes?.match(/פנייה #(\d+)/)?.[1] || lead.id.substring(0,8);
      message += `🔹 *פנייה #${leadNumber}*\n`;
      message += `   👤 ${lead.customers.name}\n`;
      message += `   📱 ${lead.customers.phone}\n`;
      message += `   📍 ${lead.customers.address}\n`;
      message += `   📝 ${lead.service_description?.substring(0, 50)}...\n\n`;
    });
    
    message += `━━━━━━━━━━━━━━━━\n`;
    message += `💡 להמשך טיפול בפנייה, שלח את מספר הפנייה\n`;
    message += `לדוגמה: 1001`;
    
    await sendWhatsAppMessage(business, ownerPhone, message);
  } catch (error) {
    console.error('Error showing pending leads:', error);
  }
}

async function showUpdatedQuote(business, quoteId, ownerPhone) {
  try {
    // שלוף את ההצעה עם כל הפרטים
    const { data: quote } = await supabase
      .from('quotes')
      .select('*, quote_items(*, products(*)), leads(*, customers(*))')
      .eq('id', quoteId)
      .single();
    
    if (!quote) {
      console.error('❌ לא נמצאה הצעה');
      return;
    }
    
    // בנה הודעה מעודכנת
    let message = `✅ *הצעת מחיר עודכנה!*\n\n`;
    message += `👤 *לקוח:* ${quote.leads.customers.name}\n`;
    message += `📍 *כתובת:* ${quote.leads.customers.address}\n\n`;
    message += `━━━━━━━━━━━━━━━━\n`;
    message += `📋 *פירוט הצעת המחיר:*\n\n`;
    
    quote.quote_items.forEach((item, index) => {
      const productName = item.product_name || item.products?.name || 'מוצר לא ידוע';
      message += `*${index + 1}. ${productName}*\n`;
      message += `   כמות: ${item.quantity} | מחיר: ₪${item.unit_price.toFixed(2)}\n`;
      message += `   סה"כ: ₪${item.total_price.toFixed(2)}\n\n`;
    });
    
    message += `━━━━━━━━━━━━━━━━\n`;
    
    // חשב סכום לפני הנחה
    const subtotal = quote.quote_items.reduce((sum, item) => sum + item.total_price, 0);
    
    // הצג סכום ביניים אם יש הנחה
    if (quote.discount_percentage > 0) {
      message += `💵 סכום ביניים: ₪${subtotal.toFixed(2)}\n`;
      message += `🎁 הנחה (${quote.discount_percentage}%): -₪${quote.discount_amount.toFixed(2)}\n`;
      message += `━━━━━━━━━━━━━━━━\n`;
    }
    
    // בדוק אם יש הנחות על פריטים ספציפיים
    const itemsWithDiscount = quote.quote_items.filter(item => item.discount_percentage > 0);
    if (itemsWithDiscount.length > 0) {
      message += `📌 *הנחות פריטים:*\n`;
      itemsWithDiscount.forEach(item => {
        const productName = item.product_name || item.products?.name || 'מוצר';
        message += `   ${productName}: ${item.discount_percentage}% הנחה\n`;
      });
      message += `━━━━━━━━━━━━━━━━\n`;
    }
    
    message += `💰 *סה"כ להצעה: ₪${quote.amount.toFixed(2)}*\n\n`;
    
    message += `*מה תרצה לעשות?*\n\n`;
    message += `1️⃣ שינוי כמות\n`;
    message += `2️⃣ שינוי מחיר\n`;
    message += `3️⃣ אישור ושליחה ללקוח ✅\n`;
    message += `4️⃣ ביטול ההצעה ❌\n`;
    message += `5️⃣ חזרה לרשימת פניות 📋\n\n`;
    message += `השב עם המספר של הפעולה הרצויה`;
    
    await sendWhatsAppMessage(business, ownerPhone, message);
    console.log('✅ הצעה מעודכנת הוצגה לבעל העסק');
    
  } catch (error) {
    console.error('❌ שגיאה בהצגת הצעה מעודכנת:', error);
  }
}

// ========================================
// 📋 טיפול בבחירת מוצרים של בעל העסק - משופר!
// ========================================
async function handleOwnerProductSelection(business, selectionText) {
  try {
    // מצא את הפנייה האחרונה שממתינה
    const { data: pendingLead } = await supabase
      .from('leads')
      .select('*, customers(*)')
      .eq('business_id', business.id)
      .eq('status', 'new')
      .like('notes', '%Waiting for quote selection%')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (!pendingLead) {
      await sendWhatsAppMessage(business, business.owner_phone,
        '❌ לא מצאתי פנייה פתוחה. אולי כבר טיפלת בה?');
      return;
    }
    
    
    // טיפול בבחירת מוצרים
    const selectedNumbers = selectionText.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    
    if (selectedNumbers.length === 0) {
      await sendWhatsAppMessage(business, business.owner_phone, 
        '❌ לא זיהיתי מספרים. נסה שוב בפורמט: 1,3,5');
      return;
    }
    
    console.log(`✅ נבחרו ${selectedNumbers.length} מוצרים: ${selectedNumbers.join(', ')}`);
    console.log(`📋 פנייה נמצאה: ${pendingLead.id} עבור ${pendingLead.customers.name}`);
    
    // שלוף את המוצרים לפי המספרים
    const { data: allProducts } = await supabase
      .from('products')
      .select('*')
      .eq('business_id', business.id)
      .eq('is_active', true)
      .order('name');
    
    const selectedProducts = selectedNumbers
      .map(num => allProducts[num - 1])
      .filter(p => p != null);
    
    if (selectedProducts.length === 0) {
      // בדוק אם זה 99 - אולי ניסה להזין הנחה כללית במקום הלא נכון
      if (selectedNumbers.length === 1 && selectedNumbers[0] === 99) {
        await sendWhatsAppMessage(business, business.owner_phone,
          '❌ נראה שניסית להזין הנחה.\n\nכדי להוסיף הנחה:\n1. צור קודם הצעת מחיר\n2. בחר אופציה 3 (הוספת הנחה)\n3. אז תוכל לבחור 99 להנחה כללית');
      } else {
      await sendWhatsAppMessage(business, business.owner_phone,
        '❌ המספרים שבחרת לא תקינים. נסה שוב.');
      }
      return;
    }
    
    console.log(`✅ מוצרים שנבחרו: ${selectedProducts.map(p => p.name).join(', ')}`);
    
    // יצור הצעת מחיר מיד עם כמות ברירת מחדל 1
    const quantities = selectedProducts.map(() => 1);
    
    // חשב סכום כולל
    let totalAmount = 0;
    const quoteItems = selectedProducts.map((product, index) => {
      const quantity = quantities[index];
      const total = parseFloat(product.base_price) * quantity;
      totalAmount += total;
      
      return {
        product,
        quantity,
        unit_price: parseFloat(product.base_price),
        total_price: total
      };
    });
    
    // צור הצעת מחיר
    const { data: quote, error } = await supabase
      .from('quotes')
      .insert({
        lead_id: pendingLead.id,
        customer_id: pendingLead.customer_id,
        business_id: business.id,
        amount: totalAmount,
        quote_text: generateDetailedQuoteText(quoteItems),
        status: 'pending_owner_approval',
        notes: '[WAITING_FOR_EDIT_CHOICE]'
      })
      .select()
      .single();
    
    if (error) {
      console.error('❌ שגיאה ביצירת הצעה:', error);
      await sendWhatsAppMessage(business, business.owner_phone, 
        '❌ שגיאה ביצירת הצעת המחיר. נסה שוב.');
      return;
    }
    
    // שמור פריטי ההצעה
    for (const item of quoteItems) {
      const { error: itemError } = await supabase
        .from('quote_items')
        .insert({
          quote_id: quote.id,
          product_id: item.product.id,
          product_name: item.product.name,
          product_description: item.product.description || '',
          quantity: item.quantity,
          unit_price: item.unit_price,
          total_price: item.total_price
        });
        
      if (itemError) {
        console.error('❌ שגיאה בשמירת פריט:', itemError);
      }
    }
    
    // הצג תצוגה מקדימה של ההצעה
    let previewMessage = `✅ *הצעת מחיר מוכנה!*\n\n`;
    previewMessage += `👤 *לקוח:* ${pendingLead.customers.name}\n`;
    previewMessage += `📍 *כתובת:* ${pendingLead.customers.address}\n\n`;
    previewMessage += `━━━━━━━━━━━━━━━━\n`;
    previewMessage += `📋 *פירוט הצעת המחיר:*\n\n`;
    
    quoteItems.forEach((item, index) => {
      previewMessage += `*${index + 1}. ${item.product.name}*\n`;
      previewMessage += `   כמות: ${item.quantity} | מחיר: ₪${item.unit_price.toFixed(2)}\n`;
      previewMessage += `   סה"כ: ₪${item.total_price.toFixed(2)}\n\n`;
    });
    
    previewMessage += `━━━━━━━━━━━━━━━━\n`;
    previewMessage += `💰 *סה"כ להצעה: ₪${totalAmount.toFixed(2)}*\n\n`;
    
    previewMessage += `*מה תרצה לעשות?*\n\n`;
    previewMessage += `1️⃣ שינוי כמות\n`;
    previewMessage += `2️⃣ שינוי מחיר\n`;
    previewMessage += `3️⃣ אישור ושליחה ללקוח ✅\n`;
    previewMessage += `4️⃣ ביטול ההצעה ❌\n\n`;
    previewMessage += `השב עם המספר של הפעולה הרצויה`;
    
    // ה-notes כבר נשמר ביצירת ההצעה, אין צורך לעדכן שוב
    
    await sendWhatsAppMessage(business, business.owner_phone, previewMessage);
    console.log('✅ הצעת מחיר נוצרה והוצגה לבעל העסק');
    
  } catch (error) {
    console.error('❌ שגיאה בטיפול בבחירת מוצרים:', error);
  }
}

// ========================================
// 📊 טיפול בהזנת כמויות
// ========================================
async function handleQuantityInput(business, lead, quantityText) {
  try {
    // חלץ את המוצרים שנבחרו מה-notes
    const productIdsMatch = lead.notes.match(/\[SELECTED_PRODUCTS\]:([^\n]+)/);
    if (!productIdsMatch) {
      console.error('❌ לא נמצאו מוצרים שנבחרו');
      return;
    }
    
    const productIds = productIdsMatch[1].split(',');
    
    // שלוף את המוצרים
    const { data: selectedProducts } = await supabase
      .from('products')
      .select('*')
      .in('id', productIds);
    
    // פרסר כמויות
    let quantities = [];
    if (quantityText.toLowerCase() === 'skip' || quantityText === '1') {
      // ברירת מחדל - 1 לכל מוצר
      quantities = selectedProducts.map(() => 1);
    } else {
      quantities = quantityText.split(',').map(q => {
        const num = parseInt(q.trim());
        return isNaN(num) || num < 1 ? 1 : num;
      });
    }
    
    // וודא שיש כמות לכל מוצר
    while (quantities.length < selectedProducts.length) {
      quantities.push(1);
    }
    
    // חשב סכום כולל
    let totalAmount = 0;
    const quoteItems = selectedProducts.map((product, index) => {
      const quantity = quantities[index];
      const total = parseFloat(product.base_price) * quantity;
      totalAmount += total;
      
      return {
        product,
        quantity,
        unit_price: parseFloat(product.base_price),
        total_price: total
      };
    });
    
    // צור הצעת מחיר
    const { data: quote, error } = await supabase
      .from('quotes')
      .insert({
        lead_id: lead.id,
        amount: totalAmount,
        quote_text: generateDetailedQuoteText(quoteItems),
        status: 'pending_owner_approval'
      })
      .select()
      .single();
    
    if (error) {
      console.error('❌ שגיאה ביצירת הצעה:', error);
      return;
    }
    
    // הוסף פריטים להצעה
    for (const item of quoteItems) {
      await supabase
        .from('quote_items')
        .insert({
          quote_id: quote.id,
          product_id: item.product.id,
          product_name: item.product.name,
          product_description: item.product.description,
          quantity: item.quantity,
          unit_price: item.unit_price,
          total_price: item.total_price
        });
    }
    
    // עדכן את הפנייה
    await supabase
      .from('leads')
      .update({ 
        status: 'quoted',
        notes: lead.notes.replace('[WAITING_FOR_QUANTITIES]', `[QUOTE_CREATED]:${quote.id}`) 
      })
      .eq('id', lead.id);
    
    // שלח תצוגה מקדימה לבעל העסק
    let previewMessage = `✅ *הצעת מחיר מוכנה!*\n\n`;
    previewMessage += `👤 *ללקוח:* ${lead.customers.name}\n`;
    previewMessage += `📱 *טלפון:* ${lead.customers.phone}\n`;
    if (lead.customers.address) {
      previewMessage += `📍 *כתובת:* ${lead.customers.address}${lead.customers.city ? `, ${lead.customers.city}` : ''}\n`;
    }
    previewMessage += `\n━━━━━━━━━━━━━━━━\n`;
    previewMessage += generateDetailedQuoteText(quoteItems);
    previewMessage += `\n━━━━━━━━━━━━━━━━\n\n`;
    previewMessage += `💰 *סה"כ לתשלום:* ₪${totalAmount.toFixed(2)}\n\n`;
    previewMessage += `📋 *מה תרצה לעשות?*\n`;
    previewMessage += `1️⃣ *שינוי כמות* - עדכן כמות למוצרים\n`;
    previewMessage += `2️⃣ *שינוי מחיר* - עדכן מחיר למוצר\n`;
    previewMessage += `3️⃣ *אישור* - שלח ללקוח\n`;
    previewMessage += `4️⃣ *ביטול* - בטל הצעה\n\n`;
    previewMessage += `השב עם המספר (1-4)`;
    
    // שמור ב-notes שממתינים לבחירת עריכה
    await supabase
      .from('quotes')
      .update({ 
        notes: '[WAITING_FOR_EDIT_CHOICE]'
      })
      .eq('id', quote.id);
    
    await sendWhatsAppMessage(business, business.owner_phone, previewMessage);
    console.log('✅ תצוגה מקדימה נשלחה לבעל העסק');
    
  } catch (error) {
    console.error('❌ שגיאה בטיפול בכמויות:', error);
  }
}

// ========================================
// 💰 יצירת טקסט הצעת מחיר מפורט
// ========================================
function generateDetailedQuoteText(quoteItems, language = 'he') {
  const templates = {
    he: {
      title: '🎯 הצעת מחיר',
      quantity: 'כמות',
      unitPrice: 'מחיר יחידה',
      totalPrice: 'סה"כ',
      grandTotal: 'סה"כ לתשלום',
      includesVAT: 'המחיר כולל מע"מ',
      validFor: 'תוקף ההצעה: 30 יום',
      thanks: 'תודה שבחרת בנו! 🙏',
    }
  };

  const t = templates[language] || templates.he;
  
  let text = `${t.title}\n\n`;
  
  quoteItems.forEach((item, index) => {
    const { product, quantity, unit_price, total_price } = item;
    
    text += `${index + 1}. *${product.name}*\n`;
    if (product.description) {
      text += `   📝 ${product.description}\n`;
    }
    text += `   💰 ${t.unitPrice}: ₪${unit_price.toFixed(2)}\n`;
    text += `   🔢 ${t.quantity}: ${quantity}\n`;
    text += `   📊 ${t.totalPrice}: ₪${total_price.toFixed(2)}\n\n`;
  });

  const grandTotal = quoteItems.reduce((sum, item) => sum + item.total_price, 0);
  
  text += `━━━━━━━━━━━━━━━━━\n`;
  text += `💳 *${t.grandTotal}: ₪${grandTotal.toFixed(2)}*\n\n`;
  text += `✅ ${t.includesVAT}\n`;
  text += `📅 ${t.validFor}\n\n`;
  text += t.thanks;

  return text;
}

// ========================================
// ✅ טיפול באישור בעל העסק
// ========================================
async function handleOwnerApproval(business, quoteId = null) {
  try {
    console.log('✅ בעל העסק אישר את ההצעה');
    
    let quote;
    
    if (quoteId) {
      // אם יש quoteId, השתמש בו
      const { data } = await supabase
        .from('quotes')
        .select('*, leads(*, customers(*)), quote_items(*)')
        .eq('id', quoteId)
        .single();
      quote = data;
    } else {
      // אחרת, מצא את ההצעה האחרונה שממתינה לאישור
      const { data } = await supabase
      .from('quotes')
      .select('*, leads(*, customers(*)), quote_items(*)')
      .eq('status', 'pending_owner_approval')
        .eq('business_id', business.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
      quote = data;
    }
    
    if (!quote) {
      await sendWhatsAppMessage(business, business.owner_phone,
        '❌ לא מצאתי הצעה שממתינה לאישור');
      return;
    }
    
    // עדכן סטטוס להצעה מאושרת ועדכן את הטקסט
    await supabase
      .from('quotes')
      .update({ 
        status: 'sent',
        quote_text: generateDetailedQuoteText(quote.quote_items.map(item => ({
          product: {
            name: item.product_name,
            description: item.product_description
          },
          quantity: item.quantity,
          unit_price: item.unit_price,
          total_price: item.total_price
        })))
      })
      .eq('id', quote.id);
    
    // עדכן גם את סטטוס ה-lead
    await supabase
      .from('leads')
      .update({ status: 'quoted' })
      .eq('id', quote.lead_id);
    
    // שלח ללקוח
    const customerPhone = quote.leads.customers.phone;
    const customerName = quote.leads.customers.name;
    
    // הכן את פריטי ההצעה לטקסט המעודכן
    const quoteItems = quote.quote_items.map(item => ({
      product: {
        name: item.product_name,
        description: item.product_description
      },
      quantity: item.quantity,
      unit_price: item.unit_price,
      total_price: item.total_price
    }));
    
    // ייצר טקסט מעודכן של ההצעה
    const updatedQuoteText = generateDetailedQuoteText(quoteItems);
    
    const customerMessage = `שלום ${customerName}! 😊

הצעת המחיר שלך מוכנה! 🎉

${updatedQuoteText}

💳 *לאישור ההצעה:*
🔗 ${process.env.FRONTEND_URL || process.env.WEBHOOK_URL || 'https://whatscrm-server.onrender.com'}/quote/${quote.id}

✍️ במקום הנוח תוכל/י לאשר את ההצעה.

📞 לשאלות או הבהרות - אנחנו כאן!`;
    
    await sendWhatsAppMessage(business, customerPhone, customerMessage);
    
    // אישור לבעל העסק
    await sendWhatsAppMessage(business, business.owner_phone,
      `✅ *ההצעה נשלחה ללקוח!*\n\n👤 ${customerName}\n📱 ${customerPhone}\n\nאעדכן אותך כשהלקוח יגיב 😊`);
    
    console.log('✅ הצעה נשלחה ללקוח');
    
    // הצג פניות פתוחות
    await showPendingLeads(business, business.owner_phone);
  } catch (error) {
    console.error('❌ שגיאה באישור הצעה:', error);
  }
}

// ========================================
// 👤 מצא לקוח
// ========================================
async function findCustomer(businessId, phone) {
  const { data } = await supabase
    .from('customers')
    .select('*')
    .eq('business_id', businessId)
    .eq('phone', phone)
    .single();

  return data;
}

// ========================================
// 🆕 צור לקוח חדש
// ========================================
async function createCustomer(businessId, phone) {
  const { data, error } = await supabase
    .from('customers')
    .insert({
      business_id: businessId,
      name: `לקוח ${phone.slice(-4)}`,
      phone: phone,
    })
    .select()
    .single();

  if (error) {
    console.error('שגיאה ביצירת לקוח:', error);
    return null;
  }

  return data;
}

// ========================================
// 📋 מצא פנייה פתוחה
// ========================================
async function findOpenLead(customerId) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('customer_id', customerId)
    .in('status', ['new', 'quoted', 'approved'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error) {
    console.log('❌ שגיאה בחיפוש פנייה:', error.message);
    return null;
  }

  return data;
}

// ========================================
// 🆕 צור פנייה חדשה - עם ניתוח AI
// ========================================
async function createLead(businessId, customerId, description, analysis) {
  // מצא את מספר הפנייה הבא
  const { data: lastLead } = await supabase
    .from('leads')
    .select('id')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  
  // חשב מספר פנייה - מתחיל מ-1001
  let leadNumber = 1001;
  if (lastLead) {
    // נסה לחלץ מספר מה-notes או מה-id
    const { count } = await supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('business_id', businessId);
    
    leadNumber = 1001 + (count || 0);
  }

  const { data, error } = await supabase
    .from('leads')
    .insert({
      business_id: businessId,
      customer_id: customerId,
      service_description: description,
      status: 'new',
      urgency: analysis.urgency || 'medium',
      ai_summary: analysis.summary || description.substring(0, 200),
      notes: `פנייה #${leadNumber}`
    })
    .select()
    .single();

  if (error) {
    console.error('שגיאה ביצירת פנייה:', error);
    return null;
  }

  // הוסף את מספר הפנייה לאובייקט
  data.leadNumber = leadNumber;
  return data;
}

// ========================================
// 📝 עדכן תיאור פנייה
// ========================================
async function updateLeadDescription(leadId, newText) {
  const { error } = await supabase
    .from('leads')
    .update({
      service_description: newText,
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId);

  if (error) {
    console.error('שגיאה בעדכון פנייה:', error);
  }
}

// ========================================
// 🔍 מצא מוצרים לפי שמות מ-Claude
// ========================================
async function findProductsByNames(businessId, productNames) {
  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('business_id', businessId)
    .eq('is_active', true);

  if (!products) return [];

  // התאם מוצרים לפי דמיון בשם
  return products.filter(product => {
    const productNameLower = product.name.toLowerCase();
    return productNames.some(name => 
      productNameLower.includes(name.toLowerCase()) || 
      name.toLowerCase().includes(productNameLower)
    );
  });
}

// ========================================
// 🎯 התאם מוצרים לתיאור (Fallback)
// ========================================
async function matchProducts(businessId, description) {
  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('business_id', businessId)
    .eq('is_active', true);

  if (!products || products.length === 0) return [];

  const descLower = description.toLowerCase();
  const scored = products.map(product => {
    let score = 0;
    const keywords = product.keywords || [];

    keywords.forEach(keyword => {
      if (descLower.includes(keyword.toLowerCase())) {
        score += 10;
      }
    });

    return { ...product, score };
  });

  return scored.filter(p => p.score > 0).sort((a, b) => b.score - a.score);
}

// ========================================
// 💰 צור הצעת מחיר אוטומטית
// ========================================
async function createAutoQuote(leadId, products) {
  const totalAmount = products.reduce((sum, p) => sum + parseFloat(p.base_price), 0);

  const { data: quote, error } = await supabase
    .from('quotes')
    .insert({
      lead_id: leadId,
      amount: totalAmount,
      quote_text: generateQuoteText(products),
      status: 'pending_approval',
    })
    .select()
    .single();

  if (error) {
    console.error('שגיאה ביצירת הצעה:', error);
    return null;
  }

  return quote;
}

function generateQuoteText(products, language = 'he') {
  const templates = {
    he: {
      title: '🎯 הצעת מחיר',
      price: 'מחיר',
      total: 'סה״כ',
      includesVAT: 'המחיר כולל מע״מ',
      validFor: 'תוקף ההצעה: 30 יום',
      thanks: 'תודה שבחרת בנו! 🙏',
    }
  };

  const t = templates[language] || templates.he;
  
  let text = `${t.title}\n\n`;
  
  products.forEach((product, index) => {
    text += `${index + 1}. ${product.name}\n`;
    if (product.description) {
      text += `   📝 ${product.description}\n`;
    }
    text += `   💰 ${t.price}: ₪${parseFloat(product.base_price).toFixed(2)}\n\n`;
  });

  const total = products.reduce((sum, p) => sum + parseFloat(p.base_price), 0);
  
  text += `━━━━━━━━━━━━━━━━━\n`;
  text += `📊 ${t.total}: ₪${total.toFixed(2)}\n\n`;
  text += `✅ ${t.includesVAT}\n`;
  text += `📅 ${t.validFor}\n\n`;
  text += t.thanks;

  return text;
}

// ========================================
// 📱 שלח הודעת WhatsApp
// ========================================
async function sendWhatsAppMessage(business, phoneNumber, message) {
  try {
    const url = `https://api.green-api.com/waInstance${business.green_api_instance}/sendMessage/${business.green_api_token}`;

    await axios.post(url, {
      chatId: `${phoneNumber}@c.us`,
      message: message,
    });

    console.log(`✅ הודעה נשלחה ל-${phoneNumber}`);
  } catch (error) {
    console.error('❌ שגיאה בשליחת הודעה:', error.message);
  }
}

// ========================================
// 📱 שליחת סיכום מלא לבעל העסק
// ========================================
async function sendCompleteSummaryToOwner(business, customer, lead) {
  try {
    // חלץ מספר פנייה
    const leadNumberMatch = lead.notes && lead.notes.match(/פנייה #(\d+)/);
    const leadNumber = leadNumberMatch ? leadNumberMatch[1] : '1001';
    
    let summaryMessage = `✅ *פנייה #${leadNumber} הושלמה - כל הפרטים התקבלו!*\n\n`;
    
    // פרטי לקוח
    summaryMessage += `👤 *לקוח:* ${customer.name}\n`;
    summaryMessage += `📱 *טלפון:* ${customer.phone}\n`;
    summaryMessage += `📍 *כתובת:* ${customer.address}${customer.city ? `, ${customer.city}` : ''}\n\n`;
    
    // תיאור הבעיה
    summaryMessage += `📝 *תיאור הבעיה:*\n${lead.service_description}\n\n`;
    
    // בדוק אם הלקוח הוסיף דברים
    if (lead.service_description && lead.service_description.includes('הערות נוספות מהלקוח:')) {
      summaryMessage += `💡 *הלקוח הוסיף פרטים נוספים לאחר הסיכום הראשוני*\n\n`;
    }
    
    // מדיה שהתקבלה
    console.log(`🔍 מחפש מדיה עבור lead: ${lead.id}`);
    const { data: media } = await supabase
      .from('lead_media')
      .select('*')
      .eq('lead_id', lead.id)
      .order('created_at', { ascending: false });
    
    console.log(`📸 נמצאו ${media?.length || 0} קבצי מדיה`);
    
    if (media && media.length > 0) {
      summaryMessage += `📸 *מדיה שהתקבלה:* ${media.length} קבצים\n`;
      
      // הצג קישורים מלאים
      for (let i = 0; i < media.length; i++) {
        const { data: urlData } = supabase.storage
          .from('lead-photos')
          .getPublicUrl(media[i].file_path);
        
        const mediaTypeEmoji = {
          'image': '📷',
          'video': '🎥',
          'audio': '🎤',
          'document': '📄'
        };
        
        summaryMessage += `${mediaTypeEmoji[media[i].media_type] || '📎'} ${urlData.publicUrl}\n`;
      }
      summaryMessage += '\n';
    }
    
    // פעולות אפשריות
    summaryMessage += `━━━━━━━━━━━━━━━━\n`;
    summaryMessage += `💼 *מה תרצה לעשות?*\n\n`;
    summaryMessage += `1️⃣ *צור הצעת מחיר*\n`;
    summaryMessage += `2️⃣ *תאם פגישה*\n`;
    summaryMessage += `3️⃣ *התקשר ללקוח* 📞\n`;
    summaryMessage += `4️⃣ *פתח WhatsApp* 💬\n\n`;
    summaryMessage += `השב עם המספר של הפעולה הרצויה (1-4)`;
    
    // שמור reference לפנייה
    await supabase
      .from('leads')
      .update({ 
        notes: (lead.notes || '') + `\n[WAITING_FOR_OWNER_ACTION]` 
      })
      .eq('id', lead.id);
    
    await sendWhatsAppMessage(business, business.owner_phone, summaryMessage);
    console.log('✅ סיכום מלא נשלח לבעל העסק');
    
  } catch (error) {
    console.error('❌ שגיאה בשליחת סיכום:', error);
  }
}

// ========================================
// 🔔 התראות
// ========================================
async function notifyBusinessOwner(business, customer, lead, analysis) {
  const urgencyEmoji = {
    high: '🔴',
    medium: '🟡',
    low: '🟢'
  };
  
  // חלץ מספר פנייה
  const leadNumberMatch = lead.notes && lead.notes.match(/פנייה #(\d+)/);
  const leadNumber = leadNumberMatch ? leadNumberMatch[1] : lead.leadNumber || '1001';
  
  console.log(`🔔 התראה לבעל עסק: ${urgencyEmoji[analysis.urgency]} פנייה #${leadNumber} ${analysis.urgency === 'high' ? 'דחופה' : ''} מ-${customer.phone}`);
  console.log(`   סיכום: ${analysis.summary}`);
  
  // בדוק אם יש פניות נוספות שלא טופלו
  const { data: pendingLeads, count: pendingCount } = await supabase
    .from('leads')
    .select('*', { count: 'exact' })
    .eq('business_id', business.id)
    .eq('status', 'new')
    .neq('id', lead.id);
  
  // ========================================
  // 📱 שלח WhatsApp לבעל העסק
  // ========================================
  
  // בנה הודעה מפורטת
  let notificationMessage = `🔔 *פנייה חדשה #${leadNumber}* ${urgencyEmoji[analysis.urgency]}\n\n`;
  notificationMessage += `👤 *לקוח:* ${customer.name}\n`;
  notificationMessage += `📱 *טלפון:* ${customer.phone}\n`;
  notificationMessage += `📍 *כתובת:* ${customer.address}${customer.city ? `, ${customer.city}` : ''}\n\n`;
  notificationMessage += `📝 *הבעיה:*\n${lead.service_description}\n\n`;
  notificationMessage += `⏰ *דחיפות:* ${analysis.urgency === 'high' ? 'גבוהה 🔴' : analysis.urgency === 'medium' ? 'בינונית 🟡' : 'נמוכה 🟢'}\n\n`;
  
  // אם יש תמונות - הוסף קישור
  const { data: media } = await supabase
    .from('lead_media')
    .select('*')
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: false })
    .limit(1);
  
  if (media && media.length > 0) {
    notificationMessage += `📷 *מדיה מצורפת:* ${media.length} קבצים\n`;
    notificationMessage += `🔗 לצפייה באפליקציה או בקישור המלא\n\n`;
  }
  
  // הוסף רשימת מוצרים לבחירה
  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('business_id', business.id)
    .eq('is_active', true)
    .order('name');
  
  if (products && products.length > 0) {
    notificationMessage += `━━━━━━━━━━━━━━━━\n`;
    notificationMessage += `🛠️ *בחר מוצרים להצעת מחיר:*\n\n`;
    
    products.forEach((product, index) => {
      notificationMessage += `*${index + 1}.* ${product.name}\n`;
      notificationMessage += `   💰 ₪${parseFloat(product.base_price).toFixed(2)}\n`;
      if (product.description) {
        notificationMessage += `   📝 ${product.description.substring(0, 50)}...\n`;
      }
      notificationMessage += `\n`;
    });
    
    notificationMessage += `━━━━━━━━━━━━━━━━\n`;
    notificationMessage += `💡 *לטיפול בפנייה #${leadNumber}:*\n`;
    notificationMessage += `השב את מספר הפנייה: *${leadNumber}*\n\n`;
    notificationMessage += `או השב:\n`;
    notificationMessage += `• *"אין מלאי"* - לדחיית הפנייה\n`;
    notificationMessage += `• *"התקשר"* - ליצירת קשר ישיר\n`;
  }
  
  // אם יש פניות נוספות - הוסף תזכורת
  if (pendingCount && pendingCount > 0) {
    notificationMessage += `\n━━━━━━━━━━━━━━━━\n`;
    notificationMessage += `⚠️ *שים לב:* יש עוד ${pendingCount} פניות ממתינות לטיפול\n`;
  }
  
  // שלח לבעל העסק
  const ownerPhone = normalizePhone(business.owner_phone);
  
  if (ownerPhone) {
    await sendWhatsAppMessage(business, ownerPhone, notificationMessage);
    console.log(`✅ התראה נשלחה לבעל העסק: ${ownerPhone}`);
  } else {
    console.log('⚠️ אין מספר טלפון לבעל העסק!');
  }
  
  // שמור את ה-lead ID בזיכרון זמני
  await supabase
    .from('leads')
    .update({ 
      notes: `Lead ID: ${lead.id} | Waiting for quote selection` 
    })
    .eq('id', lead.id);
}


async function notifyQuoteApproval(business, customer, quote) {
  console.log(`🔔 התראה: הצעה מוכנה לאישור - ₪${quote.amount}`);
  // TODO: שלח Push Notification
}

// ========================================
// 🏠 Health Check
// ========================================
app.get('/', (req, res) => {
  res.send('✅ WhatsCRM Webhook Server v2.0 is running with Claude AI!');
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    version: '2.0.0',
    features: ['Claude AI', 'Media Storage', 'Business Detection'],
    timestamp: new Date().toISOString() 
  });
});

app.get('/ping', (req, res) => {
  res.send('pong');
});

// ========================================
// 📱 נתיב לשליחת הודעות WhatsApp
// ========================================
app.post('/send-message', async (req, res) => {
  try {
    const { businessId, customerPhone, message } = req.body;
    
    if (!businessId || !customerPhone || !message) {
      return res.status(400).json({ 
        error: 'Missing required fields: businessId, customerPhone, message' 
      });
    }
    
    // מצא את העסק
    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', businessId)
      .single();
      
    if (businessError || !business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    // שלח את ההודעה
    await sendWhatsAppMessage(business, normalizePhone(customerPhone), message);
    
    res.json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    console.error('Error in /send-message:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// 📄 נתיב לשליחת הצעות מחיר
// ========================================
app.post('/send-quote', async (req, res) => {
  try {
    const { businessId, quoteId, customerPhone, customerName, quoteData, message } = req.body;
    
    if (!businessId || !customerPhone || !message) {
      return res.status(400).json({ 
        error: 'Missing required fields' 
      });
    }
    
    // מצא את העסק
    const { data: business, error: businessError } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', businessId)
      .single();
      
    if (businessError || !business) {
      return res.status(404).json({ error: 'Business not found' });
    }
    
    // שמור את דף האישור של ההצעה
    if (quoteId && quoteData) {
      const htmlTemplate = fs.readFileSync('./quote-approval-template.html', 'utf8');
      
      // החלף משתנים בתבנית
      let customHtml = htmlTemplate
        .replace(/\{\{businessName\}\}/g, quoteData.businessName || business.name)
        .replace(/\{\{quoteNumber\}\}/g, quoteData.quote_number || quoteId.slice(-6))
        .replace(/\{\{customerName\}\}/g, customerName)
        .replace(/\{\{customerPhone\}\}/g, customerPhone)
        .replace(/\{\{customerAddress\}\}/g, quoteData.customer?.address || '')
        .replace(/\{\{quoteDate\}\}/g, new Date(quoteData.created_at).toLocaleDateString('he-IL'))
        .replace(/\{\{serviceDescription\}\}/g, quoteData.notes || '')
        .replace(/\{\{totalAmount\}\}/g, (quoteData.amount || quoteData.total || 0).toFixed(2))
        .replace(/\{\{quoteId\}\}/g, quoteId);
      
      // יצירת פריטי ההצעה
      let itemsHtml = '';
      if (quoteData.quote_items && quoteData.quote_items.length > 0) {
        quoteData.quote_items.forEach(item => {
          itemsHtml += `
            <div class="item">
              <div class="item-header">
                <span class="item-name">${item.product_name}</span>
                <span class="item-price">₪${item.total_price}</span>
              </div>
              <div class="item-quantity">כמות: ${item.quantity} | מחיר ליחידה: ₪${item.unit_price}</div>
            </div>
          `;
        });
      }
      
      customHtml = customHtml.replace('{{quoteItems}}', itemsHtml);
      
      // הוסף הנחה אם קיימת
      if (quoteData.discount && quoteData.discount > 0) {
        const discountHtml = `
          <div class="info-row">
            <span class="info-label">סכום לפני הנחה:</span>
            <span>₪${(quoteData.subtotal || 0).toFixed(2)}</span>
          </div>
          <div class="info-row">
            <span class="info-label">הנחה (${quoteData.discount}%):</span>
            <span>-₪${((quoteData.subtotal * quoteData.discount / 100) || 0).toFixed(2)}</span>
          </div>
        `;
        // הכנס את ההנחה לפני הסכום הכולל
        customHtml = customHtml.replace('<!-- סה"כ -->', `<!-- הנחה -->\n${discountHtml}\n<!-- סה"כ -->`);
      }
      
      // שמור את הקובץ
      const quotesDir = './public/quotes';
      if (!fs.existsSync(quotesDir)) {
        fs.mkdirSync(quotesDir, { recursive: true });
      }
      
      fs.writeFileSync(`${quotesDir}/quote-${quoteId}.html`, customHtml);
    }
    
    // שלח את ההודעה
    await sendWhatsAppMessage(business, normalizePhone(customerPhone), message);
    
    res.json({ success: true, message: 'Quote sent successfully' });
  } catch (error) {
    console.error('Error in /send-quote:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// 🧹 ניקוי מדיה ידני
// ========================================
app.post('/cleanup-media', async (req, res) => {
  await cleanupExpiredMedia();
  res.json({ success: true, message: 'Cleanup completed' });
});

// ========================================
// 📄 Serve static files
// ========================================
app.use('/quote', express.static('public'));

// ========================================
// 🔗 Quote approval endpoints
// ========================================
app.get('/quote/:quoteId', async (req, res) => {
  try {
    const { quoteId } = req.params;
    const { discount } = req.query; // Get discount from URL parameter
    
    // תחילה בדוק אם יש קובץ HTML שמור להצעה הספציפית
    const savedQuotePath = `./public/quotes/quote-${quoteId}.html`;
    if (fs.existsSync(savedQuotePath)) {
      // אם יש הנחה בפרמטרים, עדכן את הקובץ
      if (discount) {
        let savedHtml = fs.readFileSync(savedQuotePath, 'utf8');
        
        // מצא את הסכום הכולל המקורי
        const totalMatch = savedHtml.match(/₪([\d,]+\.?\d*)<\/div>\s*<\/div>\s*<!-- חתימה -->/);
        if (totalMatch) {
          const originalTotal = parseFloat(totalMatch[1].replace(/,/g, ''));
          const discountPercentage = parseFloat(discount);
          const subtotal = originalTotal / (1 - discountPercentage / 100);
          const discountAmount = subtotal * (discountPercentage / 100);
          
          // הוסף את ההנחה לפני הסכום הכולל
          const discountHtml = `
            <div class="info-row">
              <span class="info-label">סכום לפני הנחה:</span>
              <span>₪${subtotal.toFixed(2)}</span>
            </div>
            <div class="info-row">
              <span class="info-label">הנחה (${discountPercentage}%):</span>
              <span>-₪${discountAmount.toFixed(2)}</span>
            </div>
          `;
          
          // הכנס את ההנחה לפני הסכום הכולל
          savedHtml = savedHtml.replace('<!-- סה"כ -->', `<!-- הנחה -->\n${discountHtml}\n<!-- סה"כ -->`);
        }
        
        return res.send(savedHtml);
      }
      return res.sendFile(path.resolve(savedQuotePath));
    }
    
    // Get quote details
    const { data: quote, error } = await supabase
      .from('quotes')
      .select(`
        *,
        leads!quotes_lead_id_fkey (
          *,
          customers!leads_customer_id_fkey (*),
          businesses!leads_business_id_fkey (*)
        ),
        quote_items (*)
      `)
      .eq('id', quoteId)
      .single();
    
    if (error || !quote) {
      return res.status(404).send('הצעת מחיר לא נמצאה');
    }
    
    // Check if template exists, if not create it
    const templatePath = './public/quote-approval-template.html';
    if (!fs.existsSync('./public')) {
      fs.mkdirSync('./public', { recursive: true });
    }
    
    let template;
    if (fs.existsSync(templatePath)) {
      template = fs.readFileSync(templatePath, 'utf8');
    } else {
      // Create default template
      template = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>הצעת מחיר - {{businessName}}</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            background: #f5f5f5;
            padding: 20px;
            margin: 0;
        }
        .container {
            max-width: 600px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            padding: 30px;
        }
        .header {
            text-align: center;
            margin-bottom: 30px;
        }
        .header h1 {
            color: #25D366;
            margin-bottom: 10px;
        }
        .info {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 30px;
        }
        .info-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
        }
        .items {
            margin-bottom: 30px;
        }
        .item {
            border-bottom: 1px solid #eee;
            padding: 15px 0;
        }
        .total {
            font-size: 24px;
            font-weight: bold;
            text-align: center;
            color: #25D366;
            margin: 30px 0;
        }
        .actions {
            display: flex;
            gap: 10px;
        }
        .btn {
            flex: 1;
            padding: 15px;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
        }
        .btn-approve {
            background: #25D366;
            color: white;
        }
        .btn-reject {
            background: #e0e0e0;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>הצעת מחיר</h1>
            <p>{{businessName}}</p>
        </div>
        
        <div class="info">
            <div class="info-row">
                <span>מספר הצעה:</span>
                <span>{{quoteNumber}}</span>
            </div>
            <div class="info-row">
                <span>תאריך:</span>
                <span>{{quoteDate}}</span>
            </div>
            <div class="info-row">
                <span>לכבוד:</span>
                <span>{{customerName}}</span>
            </div>
            <div class="info-row">
                <span>כתובת:</span>
                <span>{{customerAddress}}</span>
            </div>
        </div>
        
        <div class="items">
            <h2>פירוט ההצעה:</h2>
            {{quoteItems}}
        </div>
        
        <div class="total">
            סה"כ לתשלום: ₪{{totalAmount}}
        </div>
        
        <div class="actions">
            <button class="btn btn-approve" onclick="window.location.href='/approve-quote/{{quoteId}}'">
                ✓ אישור ההצעה
            </button>
            <button class="btn btn-reject" onclick="window.location.href='/reject-quote/{{quoteId}}'">
                ✗ דחיית ההצעה
            </button>
        </div>
    </div>
</body>
</html>`;
    }
    
    // Generate quote items HTML
    let itemsHtml = '';
    quote.quote_items.forEach((item, index) => {
      itemsHtml += `
        <div class="item">
          <div class="item-header">
            <span class="item-name">${index + 1}. ${item.product_name}</span>
            <span class="item-price">₪${item.unit_price.toFixed(2)}</span>
          </div>
          ${item.product_description ? `<div class="item-description">${item.product_description}</div>` : ''}
          <div class="item-quantity">כמות: ${item.quantity} | סה"כ: ₪${(item.unit_price * item.quantity).toFixed(2)}</div>
        </div>
      `;
    });
    
    // Calculate subtotal
    const subtotal = quote.quote_items.reduce((sum, item) => sum + (item.unit_price * item.quantity), 0);
    
    // Apply discount if provided in URL or quote
    const discountPercentage = parseFloat(discount) || quote.discount || 0;
    const discountAmount = subtotal * (discountPercentage / 100);
    const totalAmount = subtotal - discountAmount;
    
    // Replace placeholders
    template = template.replace(/{{businessName}}/g, quote.leads.businesses.business_name || 'העסק שלנו');
    template = template.replace(/{{quoteNumber}}/g, quote.id.substring(0, 8));
    template = template.replace(/{{customerName}}/g, quote.leads.customers.name);
    template = template.replace(/{{customerPhone}}/g, quote.leads.customers.phone);
    template = template.replace(/{{customerAddress}}/g, `${quote.leads.customers.address || ''} ${quote.leads.customers.city || ''}`);
    template = template.replace(/{{quoteDate}}/g, new Date(quote.created_at).toLocaleDateString('he-IL'));
    template = template.replace(/{{serviceDescription}}/g, quote.leads.service_description);
    template = template.replace(/{{quoteItems}}/g, itemsHtml);
    
    // Add discount info if exists
    if (discountPercentage > 0) {
      const discountHtml = `
        <div class="info-row">
          <span class="info-label">סכום לפני הנחה:</span>
          <span>₪${subtotal.toFixed(2)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">הנחה (${discountPercentage}%):</span>
          <span>-₪${discountAmount.toFixed(2)}</span>
        </div>
      `;
      // Insert discount info before the total section
      template = template.replace('<!-- סה"כ -->', `<!-- הנחה -->\n${discountHtml}\n<!-- סה"כ -->`);
    }
    
    template = template.replace(/{{totalAmount}}/g, totalAmount.toFixed(2));
    template = template.replace(/{{quoteId}}/g, quoteId);
    
    res.send(template);
  } catch (error) {
    console.error('Error serving quote page:', error);
    res.status(500).send('שגיאה בטעינת הצעת המחיר');
  }
});

app.post('/api/approve-quote', async (req, res) => {
  try {
    const { quoteId, signature, approvedAt } = req.body;
    
    // Update quote status
    const { data: quote, error: updateError } = await supabase
      .from('quotes')
      .update({
        status: 'approved',
        approved_at: approvedAt,
        notes: 'אושר על ידי הלקוח'
      })
      .eq('id', quoteId)
      .select('*, leads!quotes_lead_id_fkey(*, customers!leads_customer_id_fkey(*), businesses!leads_business_id_fkey(*))')
      .single();
    
    if (updateError) throw updateError;
    
    // Save signature in lead_media
    if (signature) {
      const base64Data = signature.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      const fileName = `signature_${quoteId}_${Date.now()}.png`;
      
      await supabase.storage
        .from('lead-photos')
        .upload(fileName, buffer, {
          contentType: 'image/png',
          cacheControl: '3600',
        });
      
      await supabase
        .from('lead_media')
        .insert({
          lead_id: quote.lead_id,
          media_type: 'image',
          file_path: fileName,
          caption: 'חתימת לקוח על הצעת מחיר'
        });
    }
    
    // Update lead status
    await supabase
      .from('leads')
      .update({ status: 'approved' })
      .eq('id', quote.lead_id);
    
    // Send confirmation to customer
    const customer = quote.leads.customers;
    const business = quote.leads.businesses;
    
    const confirmationMessage = `✅ תודה ${customer.name}!

הצעת המחיר אושרה בהצלחה.

נציג יצור איתך קשר בהקדם לתיאום מועד הביצוע.

תודה שבחרת ב-${business.business_name}! 🙏`;
    
    await sendWhatsAppMessage(business, customer.phone, confirmationMessage);
    
    // Notify business owner
    const ownerMessage = `🎉 *הצעת מחיר אושרה!*

👤 *לקוח:* ${customer.name}
📱 *טלפון:* ${customer.phone}
💰 *סכום:* ₪${quote.amount || 0}

✍️ הלקוח אישר את ההצעה וחתם דיגיטלית.

🔗 לצפייה בחתימה: ${process.env.WEBHOOK_URL}/quote/${quoteId}

📞 צור קשר לתיאום ביצוע העבודה.`;
    
    await sendWhatsAppMessage(business, business.owner_phone, ownerMessage);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error approving quote:', error);
    res.status(500).json({ error: 'Failed to approve quote' });
  }
});

// ========================================
// ✅ Quote approval endpoint
// ========================================
app.get('/quote-approval/:quoteId', async (req, res) => {
  try {
    const { quoteId } = req.params;
    
    // בדוק אם יש קובץ HTML שמור
    const savedQuotePath = `./public/quotes/quote-${quoteId}.html`;
    if (fs.existsSync(savedQuotePath)) {
      return res.sendFile(path.resolve(savedQuotePath));
    }
    
    // אם לא, החזר לנתיב הרגיל
    return res.redirect(`/quote/${quoteId}`);
  } catch (error) {
    console.error('Error in /quote-approval:', error);
    res.status(500).send('שגיאה בטעינת הצעת המחיר');
  }
});

app.get('/approve-quote/:quoteId', async (req, res) => {
  try {
    const { quoteId } = req.params;
    
    // בדוק קודם אם ההצעה כבר אושרה
    const { data: existingQuote } = await supabase
      .from('quotes')
      .select('status')
      .eq('id', quoteId)
      .single();
    
    if (existingQuote && existingQuote.status === 'approved') {
      // אם כבר אושרה, פשוט תציג הודעת אישור
      return res.send(`
        <!DOCTYPE html>
        <html lang="he" dir="rtl">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>הצעה אושרה</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background-color: #f5f5f5;
            }
            .message {
              text-align: center;
              padding: 40px;
              background: white;
              border-radius: 10px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            .success-icon {
              font-size: 60px;
              color: #4CAF50;
              margin-bottom: 20px;
            }
          </style>
        </head>
        <body>
          <div class="message">
            <div class="success-icon">✅</div>
            <h1>ההצעה כבר אושרה!</h1>
            <p>תודה על האישור. קיבלנו את הפרטים שלך.</p>
          </div>
        </body>
        </html>
      `);
    }
    
    // Update quote status
    const { data: quote, error } = await supabase
      .from('quotes')
      .update({ 
        status: 'approved',
        approved_at: new Date().toISOString()
      })
      .eq('id', quoteId)
      .select('*, leads(*, customers(*), businesses(*))')
      .single();
    
    if (error || !quote) {
      return res.status(404).send('הצעת מחיר לא נמצאה');
    }
    
    // Send notification to business owner
    const business = quote.leads.businesses;
    const customer = quote.leads.customers;
    
    // יצירת ושמירת PDF של ההצעה המאושרת
    try {
      // בנה HTML להצעה
      const { data: quoteItems } = await supabase
        .from('quote_items')
        .select('*')
        .eq('quote_id', quoteId);
      
      let htmlContent = `
        <!DOCTYPE html>
        <html dir="rtl">
        <head>
          <meta charset="UTF-8">
          <title>הצעת מחיר מאושרת - ${customer.name}</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            .header { background: #4CAF50; color: white; padding: 20px; text-align: center; }
            .customer-info { margin: 20px 0; }
            .items { margin: 20px 0; }
            .item { border-bottom: 1px solid #eee; padding: 10px 0; }
            .total { font-size: 20px; font-weight: bold; margin-top: 20px; }
            .approved { color: #4CAF50; font-weight: bold; text-align: center; margin: 20px 0; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>הצעת מחיר מאושרת</h1>
            <p>${business.name}</p>
          </div>
          
          <div class="approved">✅ אושר על ידי הלקוח בתאריך: ${new Date().toLocaleDateString('he-IL')}</div>
          
          <div class="customer-info">
            <h2>פרטי לקוח:</h2>
            <p>שם: ${customer.name}</p>
            <p>טלפון: ${customer.phone}</p>
            <p>כתובת: ${customer.address || ''}</p>
          </div>
          
          <div class="items">
            <h2>פירוט ההצעה:</h2>
            ${quoteItems.map((item, index) => `
              <div class="item">
                <strong>${index + 1}. ${item.product_name}</strong><br>
                כמות: ${item.quantity} × ₪${item.unit_price.toFixed(2)} = ₪${item.total_price.toFixed(2)}
              </div>
            `).join('')}
          </div>
          
          ${(() => {
            console.log('Quote data:', { discount: quote.discount, subtotal: quote.subtotal, amount: quote.amount });
            return quote.discount && quote.discount > 0 ? `
            <div class="discount-section" style="margin: 20px 0; padding: 10px; background: #f5f5f5;">
              <p>סכום לפני הנחה: ₪${(quote.subtotal || 0).toFixed(2)}</p>
              <p>הנחה (${quote.discount}%): -₪${((quote.subtotal * quote.discount / 100) || 0).toFixed(2)}</p>
            </div>
            ` : '';
          })()}
          
          <div class="total">
            סה"כ לתשלום: ₪${quote.amount.toFixed(2)}
          </div>
        </body>
        </html>
      `;
      
      // כרגע נשמור את ה-HTML כקובץ טקסט
      const fileName = `quote_${quoteId}_${Date.now()}.html`;
      const filePath = fileName;
      
      // שמור ב-Storage
      const { data: uploadData, error: uploadError } = await supabase.storage
        .from('quote-pdfs')
        .upload(filePath, htmlContent, {
          contentType: 'text/html',
          upsert: false
        });
      
      if (uploadError) {
        console.error('❌ שגיאה בשמירת קובץ ההצעה:', uploadError);
        // המשך בכל מקרה - זה לא קריטי
      } else {
        console.log(`✅ הצעה נשמרה בהצלחה: ${filePath}`);
        
        // עדכן את ההצעה עם הקישור לקובץ
        await supabase
          .from('quotes')
          .update({ pdf_url: filePath })
          .eq('id', quoteId);
      }
    } catch (pdfError) {
      console.error('❌ שגיאה ביצירת PDF:', pdfError);
    }
    
    await sendWhatsAppMessage(business, business.owner_phone, 
      `✅ *הצעת מחיר אושרה!*\n\n` +
      `👤 לקוח: ${customer.name}\n` +
      `💰 סכום: ₪${quote.amount.toFixed(2)}\n\n` +
      `📞 צור קשר עם הלקוח לתיאום ביצוע\n\n` +
      `כדי לתאם פגישה, שלח "פגישה"`
    );
    
    // שלח אישור ללקוח
    await sendWhatsAppMessage(business, customer.phone,
      `תודה ${customer.name}! 🎉\n\n` +
      `ההצעה שלך אושרה בהצלחה.\n\n` +
      `בעל העסק יצור איתך קשר בקרוב לתיאום מועד הגעה.\n\n` +
      `תודה שבחרת ב-${business.business_name}! 🙏`
    );
    
    // הקפא מענה אוטומטי ל-24 שעות
    console.log('🔕 מקפיא מענה אוטומטי ל-24 שעות אחרי אישור הצעה');
    await supabase
      .from('customers')
      .update({ 
        notes: `[GENERAL_CORRESPONDENCE_24H]|UNTIL:${new Date(Date.now() + 24*60*60*1000).toISOString()}`,
        updated_at: new Date().toISOString()
      })
      .eq('id', customer.id);
    
    res.send(`
      <!DOCTYPE html>
      <html lang="he" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>אישור התקבל</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: #f5f5f5;
          }
          .message {
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            text-align: center;
          }
          .icon {
            font-size: 60px;
            color: #25D366;
            margin-bottom: 20px;
          }
          h1 {
            color: #333;
            margin-bottom: 10px;
          }
          p {
            color: #666;
          }
        </style>
      </head>
      <body>
        <div class="message">
          <div class="icon">✓</div>
          <h1>תודה על האישור!</h1>
          <p>ההצעה אושרה בהצלחה</p>
          <p>נציג יצור איתך קשר בקרוב</p>
        </div>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error('Error approving quote:', error);
    res.status(500).send('שגיאה באישור ההצעה');
  }
});

// ========================================
// 📅 Appointment selection endpoint
// ========================================
app.get('/appointment/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    
    // Get lead and appointment options
    const { data: lead, error } = await supabase
      .from('leads')
      .select(`
        *,
        customers!leads_customer_id_fkey (*),
        businesses!leads_business_id_fkey (*)
      `)
      .eq('id', leadId)
      .single();
    
    if (error || !lead) {
      return res.status(404).send('פנייה לא נמצאה');
    }
    
    // Extract appointment options from notes
    const optionsMatch = lead.notes?.match(/\[APPOINTMENT_OPTIONS\]\|(.+?)(\n|$)/);
    if (!optionsMatch) {
      return res.status(404).send('אין אפשרויות פגישה זמינות');
    }
    
    const appointmentOptions = JSON.parse(optionsMatch[1]);
    const business = lead.businesses;
    const customer = lead.customers;
    
    // Generate HTML for appointment selection
    const html = `
      <!DOCTYPE html>
      <html lang="he" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>בחירת מועד פגישה - ${business.business_name}</title>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            background-color: #f5f5f5;
            line-height: 1.6;
            color: #333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            padding: 30px;
            text-align: center;
            color: white;
            border-radius: 10px 10px 0 0;
          }
          .content {
            background: white;
            padding: 30px;
            border-radius: 0 0 10px 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          h1 {
            font-size: 28px;
            margin-bottom: 10px;
          }
          .business-name {
            font-size: 18px;
            opacity: 0.9;
          }
          .appointment-option {
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 15px;
            cursor: pointer;
            transition: all 0.3s ease;
            background: white;
          }
          .appointment-option:hover {
            border-color: #667eea;
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.15);
            transform: translateY(-2px);
          }
          .appointment-option.selected {
            border-color: #667eea;
            background: #f8f9ff;
          }
          .day-name {
            font-size: 20px;
            font-weight: bold;
            color: #333;
            margin-bottom: 5px;
          }
          .date {
            font-size: 16px;
            color: #666;
            margin-bottom: 10px;
          }
          .time {
            font-size: 18px;
            color: #667eea;
            font-weight: 500;
          }
          .confirm-button {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            padding: 15px 40px;
            font-size: 18px;
            border-radius: 50px;
            cursor: pointer;
            width: 100%;
            margin-top: 20px;
            transition: all 0.3s ease;
            font-weight: bold;
          }
          .confirm-button:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(102, 126, 234, 0.3);
          }
          .confirm-button:disabled {
            background: #ccc;
            cursor: not-allowed;
            transform: none;
          }
          .info-section {
            background: #f8f9ff;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
          }
          .info-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
          }
          .info-label {
            font-weight: bold;
            color: #666;
          }
          .message {
            text-align: center;
            padding: 40px;
            background: white;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
          }
          .success-icon {
            font-size: 60px;
            color: #4caf50;
            margin-bottom: 20px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div id="selection-view">
            <div class="header">
              <h1>בחירת מועד פגישה</h1>
              <div class="business-name">${business.business_name}</div>
            </div>
            <div class="content">
              <div class="info-section">
                <div class="info-row">
                  <span class="info-label">שם:</span>
                  <span>${customer.name}</span>
                </div>
                <div class="info-row">
                  <span class="info-label">כתובת:</span>
                  <span>${customer.address || 'יתואם'}</span>
                </div>
              </div>
              
              <h3 style="margin-bottom: 20px;">בחר מועד מועדף:</h3>
              
              <form id="appointment-form">
                ${appointmentOptions.map((option, index) => `
                  <div class="appointment-option" onclick="selectOption(${index})">
                    <input type="radio" name="appointment" value="${index}" id="option-${index}" style="display: none;">
                    <div class="day-name">${option.dayName}</div>
                    <div class="date">${option.displayDate}</div>
                    <div class="time">⏰ ${option.time}</div>
                  </div>
                `).join('')}
                
                <button type="submit" class="confirm-button" disabled>
                  אשר מועד פגישה
                </button>
              </form>
            </div>
          </div>
          
          <div id="success-view" style="display: none;">
            <div class="message">
              <div class="success-icon">✓</div>
              <h2>הפגישה נקבעה בהצלחה!</h2>
              <p>קיבלת אישור ב-WhatsApp</p>
              <p>נתראה במועד שנקבע 😊</p>
            </div>
          </div>
        </div>
        
        <script>
          let selectedOption = null;
          
          function selectOption(index) {
            // Remove previous selection
            document.querySelectorAll('.appointment-option').forEach(el => {
              el.classList.remove('selected');
            });
            
            // Add selection to clicked option
            document.querySelectorAll('.appointment-option')[index].classList.add('selected');
            document.getElementById('option-' + index).checked = true;
            
            selectedOption = index;
            document.querySelector('.confirm-button').disabled = false;
          }
          
          document.getElementById('appointment-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            if (selectedOption === null) return;
            
            try {
              const response = await fetch('/confirm-appointment/${leadId}', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  selectedIndex: selectedOption
                })
              });
              
              if (response.ok) {
                document.getElementById('selection-view').style.display = 'none';
                document.getElementById('success-view').style.display = 'block';
              } else {
                alert('אירעה שגיאה בקביעת הפגישה. נסה שוב.');
              }
            } catch (error) {
              alert('אירעה שגיאה בקביעת הפגישה. נסה שוב.');
            }
          });
        </script>
      </body>
      </html>
    `;
    
    res.send(html);
    
  } catch (error) {
    console.error('Error in appointment selection:', error);
    res.status(500).send('שגיאה בטעינת אפשרויות הפגישה');
  }
});

// ========================================
// 📅 Mark customer waiting for appointment choice
// ========================================
app.post('/api/mark-appointment-sent', async (req, res) => {
  try {
    const { customerId, leadId, appointmentOptions } = req.body;
    
    console.log('📅 mark-appointment-sent called:', { customerId, leadId, appointmentOptions });
    
    if (!customerId || !leadId || !appointmentOptions) {
      return res.status(400).json({ error: 'חסרים פרטים נדרשים' });
    }
    
    // עדכן את ה-notes של הלקוח
    await supabase
      .from('customers')
      .update({ 
        notes: `[WAITING_FOR_APPOINTMENT_CHOICE]|LEAD:${leadId}|FROM_APP` 
      })
      .eq('id', customerId);
    
    // עדכן את ה-notes של הפנייה עם האופציות
    const { data: lead } = await supabase
      .from('leads')
      .select('notes')
      .eq('id', leadId)
      .single();
    
    // נקה סטטוסים ישנים ממערכת אחרת
    let cleanedNotes = (lead?.notes || '').replace(/\[SELECTING_APPOINTMENT_DAYS\]\|.+?(\n|$)/g, '');
    cleanedNotes = cleanedNotes.replace(/\[SELECTING_APPOINTMENT_TIMES_MULTI\]\|.+?(\n|$)/g, '');
    cleanedNotes = cleanedNotes.replace(/\[WAITING_FOR_OWNER_ACTION\](\n|$)/g, '');
    
    // פורמט הפגישות כמו שהשרת מצפה
    const formattedOptions = appointmentOptions.map((opt, index) => ({
      index: index + 1,
      date: opt.date,
      time: opt.time,
      displayDate: opt.displayDate,
      dayName: opt.dayName,
      location: 'יתואם',
      duration: opt.duration
    }));
    
    const updatedNotes = cleanedNotes + '\n[APPOINTMENT_OPTIONS]|' + JSON.stringify(formattedOptions);
    
    console.log('📝 Updating lead notes with:', updatedNotes);
    
    const { error: updateError } = await supabase
      .from('leads')
      .update({ 
        notes: updatedNotes,
        status: 'appointment_scheduling'
      })
      .eq('id', leadId);
    
    if (updateError) {
      console.error('❌ Error updating lead:', updateError);
      throw updateError;
    }
    
    console.log('✅ Lead updated successfully');
    res.json({ success: true });
  } catch (error) {
    console.error('Error marking appointment sent:', error);
    res.status(500).json({ error: 'שגיאה בסימון שליחת פגישה' });
  }
});

// ========================================
// ✅ Confirm appointment endpoint
// ========================================
app.post('/confirm-appointment/:leadId', async (req, res) => {
  try {
    const { leadId } = req.params;
    const { selectedIndex } = req.body;
    
    // Get lead details
    const { data: lead, error } = await supabase
      .from('leads')
      .select(`
        *,
        customers!leads_customer_id_fkey (*),
        businesses!leads_business_id_fkey (*)
      `)
      .eq('id', leadId)
      .single();
    
    if (error || !lead) {
      return res.status(404).json({ error: 'פנייה לא נמצאה' });
    }
    
    // Extract appointment options
    const optionsMatch = lead.notes?.match(/\[APPOINTMENT_OPTIONS\]\|(.+?)(\n|$)/);
    if (!optionsMatch) {
      return res.status(404).json({ error: 'אין אפשרויות פגישה' });
    }
    
    const appointmentOptions = JSON.parse(optionsMatch[1]);
    const selectedSlot = appointmentOptions[selectedIndex];
    
    if (!selectedSlot) {
      return res.status(400).json({ error: 'אופציה לא תקינה' });
    }
    
    const business = lead.businesses;
    const customer = lead.customers;
    
    // Create appointment
    const { data: appointment, error: appointmentError } = await supabase
      .from('appointments')
      .insert({
        lead_id: leadId,
        business_id: business.id,
        customer_id: customer.id,
        appointment_date: selectedSlot.date,
        appointment_time: selectedSlot.time + ':00',
        duration: selectedSlot.duration || 90,
        status: 'confirmed',
        location: customer.full_address || customer.address || 'יתואם',
        notes: 'נקבעה דרך קישור אישור'
      })
      .select()
      .single();
    
    if (appointmentError) {
      console.error('Error creating appointment:', appointmentError);
      return res.status(500).json({ error: 'שגיאה בקביעת הפגישה' });
    }
    
    const date = new Date(selectedSlot.date);
    const dayName = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'][date.getDay()];
    const dateStr = date.toLocaleDateString('he-IL');
    
    // Send confirmation to customer
    await sendWhatsAppMessage(business, customer.phone,
      `✅ *הפגישה נקבעה בהצלחה!*\n\n` +
      `📅 ${dayName}, ${dateStr}\n` +
      `⏰ ${selectedSlot.time}\n` +
      `📍 ${customer.full_address || customer.address || 'יתואם'}\n\n` +
      `ניפגש ! 😊`
    );
    
    // Notify business owner
    await sendWhatsAppMessage(business, normalizePhone(business.owner_phone),
      `✅ *פגישה נקבעה!*\n\n` +
      `👤 לקוח: ${customer.name}\n` +
      `📱 טלפון: ${customer.phone}\n` +
      `📅 ${dayName}, ${dateStr}\n` +
      `⏰ ${selectedSlot.time}\n` +
      `📍 ${customer.full_address || customer.address || 'יתואם'}\n\n` +
      `💡 הלקוח אישר דרך הקישור`
    );
    
    // Update lead status
    await supabase
      .from('leads')
      .update({ 
        status: 'scheduled',
        notes: lead.notes.replace(/\[APPOINTMENT_OPTIONS\]\|.+?(\n|$)/, '[APPOINTMENT_SCHEDULED]')
      })
      .eq('id', leadId);
    
    // Clear customer notes
    await supabase
      .from('customers')
      .update({ notes: '' })
      .eq('id', customer.id);
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Error confirming appointment:', error);
    res.status(500).json({ error: 'שגיאה בקביעת הפגישה' });
  }
});

// ========================================
// ❌ Quote rejection endpoint
// ========================================
app.get('/reject-quote/:quoteId', async (req, res) => {
  try {
    const { quoteId } = req.params;
    
    // Update quote status
    const { data: quote, error } = await supabase
      .from('quotes')
      .update({ 
        status: 'rejected',
        rejected_at: new Date().toISOString()
      })
      .eq('id', quoteId)
      .select('*, leads(*, customers(*), businesses(*))')
      .single();
    
    if (error || !quote) {
      return res.status(404).send('הצעת מחיר לא נמצאה');
    }
    
    // Send notification to business owner
    const business = quote.leads.businesses;
    await sendWhatsAppMessage(business, business.owner_phone, 
      `❌ *הצעת מחיר נדחתה*\n\n` +
      `👤 לקוח: ${quote.leads.customers.name}\n` +
      `💰 סכום: ₪${quote.amount.toFixed(2)}\n\n` +
      `💡 שקול ליצור קשר עם הלקוח להבנת הסיבה`
    );
    
    res.send(`
      <!DOCTYPE html>
      <html lang="he" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>הצעה נדחתה</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            background: #f5f5f5;
          }
          .message {
            background: white;
            padding: 40px;
            border-radius: 12px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            text-align: center;
          }
          .icon {
            font-size: 60px;
            color: #999;
            margin-bottom: 20px;
          }
          h1 {
            color: #333;
            margin-bottom: 10px;
          }
          p {
            color: #666;
          }
        </style>
      </head>
      <body>
        <div class="message">
          <div class="icon">✗</div>
          <h1>ההצעה נדחתה</h1>
          <p>תודה על התגובה</p>
        </div>
      </body>
      </html>
    `);
    
  } catch (error) {
    console.error('Error rejecting quote:', error);
    res.status(500).send('שגיאה בדחיית ההצעה');
  }
});

// ========================================
// 🗓️ תיאום פגישות
// ========================================
async function startAppointmentScheduling(business, lead, customer, ownerPhone) {
  try {
    console.log('🗓️ מתחיל תהליך תיאום פגישה');
    
    // בדוק אם יש כתובת מלאה
    if (!customer.full_address && (!customer.address || customer.address.length < 10)) {
      console.log('📍 אין כתובת מלאה - מבקש מהלקוח');
      
      // בקש כתובת מלאה מהלקוח
      await sendWhatsAppMessage(business, customer.phone,
        `שלום ${customer.name}! 👋\n\n` +
        `בעל העסק מעוניין לתאם איתך פגישה.\n\n` +
        `כדי שנוכל להגיע אליך, אנא שלח/י כתובת מלאה:\n` +
        `📍 רחוב ומספר בית\n` +
        `🏢 קומה ודירה (אם רלוונטי)\n` +
        `🔐 קוד כניסה לבניין (אם יש)\n\n` +
        `דוגמה: רחוב הרצל 25, קומה 3 דירה 12, קוד כניסה 1234#`
      );
      
      // עדכן את ה-notes של הלקוח
      await supabase
        .from('customers')
        .update({ notes: `[WAITING_FOR_ADDRESS_FOR_APPOINTMENT]|LEAD:${lead.id}` })
        .eq('id', customer.id);
      
      // הודע לבעל העסק
      await sendWhatsAppMessage(business, ownerPhone,
        `📍 ביקשתי מהלקוח כתובת מלאה לתיאום הפגישה.\n\nאחכה לתשובתו ואעדכן אותך.`
      );
      
      return;
    }
    
    // שלוף את הזמינות של העסק
    const { data: availability } = await supabase
      .from('business_availability')
      .select('*')
      .eq('business_id', business.id)
      .eq('is_active', true)
      .order('day_of_week');
    
    if (!availability || availability.length === 0) {
      await sendWhatsAppMessage(business, ownerPhone,
        '❌ לא נמצאה זמינות מוגדרת לעסק.\n\nהגדר קודם את שעות הפעילות במערכת.');
      return;
    }
    
    // הצג ימים זמינים לבחירה
    let message = '🗓️ *תיאום פגישה*\n\n';
    message += `👤 לקוח: ${customer.name}\n`;
    message += `📍 כתובת: ${customer.full_address || customer.address}\n\n`;
    message += '📅 *בחר 1-3 תאריכים לפגישה:*\n\n';
    
    const daysOptions = [];
    const today = new Date();
    const dayNames = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    
    // הצג 14 ימים קדימה
    for (let i = 0; i < 14; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      const dayOfWeek = date.getDay();
      
      // בדוק אם יש זמינות ביום זה
      const dayAvailability = availability.find(a => a.day_of_week === dayOfWeek);
      if (dayAvailability) {
        const dateStr = date.toISOString().split('T')[0];
        const dayName = dayNames[dayOfWeek];
        const displayDate = date.toLocaleDateString('he-IL');
        
        daysOptions.push({
          date: dateStr,
          dayName: dayName,
          displayDate: displayDate,
          availability: dayAvailability
        });
        
        message += `${daysOptions.length}. ${dayName} ${displayDate}\n`;
      }
    }
    
    if (daysOptions.length === 0) {
      await sendWhatsAppMessage(business, ownerPhone,
        '❌ אין ימים זמינים בשבועיים הקרובים על פי הגדרות הזמינות שלך.');
      return;
    }
    
    message += '\n*דוגמה:* 1,3,5 (לבחירת ימים 1, 3 ו-5)\n';
    message += 'או רק מספר אחד לבחירת יום בודד';
    
    // שמור את האופציות
    await supabase
      .from('leads')
      .update({ 
        notes: lead.notes + `\n[SELECTING_APPOINTMENT_DAYS]|${JSON.stringify(daysOptions)}`
      })
      .eq('id', lead.id);
    
    await sendWhatsAppMessage(business, ownerPhone, message);
    
  } catch (error) {
    console.error('❌ שגיאה בתיאום פגישה:', error);
    await sendWhatsAppMessage(business, ownerPhone,
      '❌ שגיאה בתיאום הפגישה. נסה שוב.');
  }
}

// ========================================
// 📅 חישוב זמנים פנויים ליום ספציפי
// ========================================
async function calculateDaySlots(businessId, dateStr, dayAvailability) {
  const slots = [];
  
  // שלוף פגישות קיימות ביום זה
  const { data: existingAppointments } = await supabase
    .from('appointments')
    .select('*')
    .eq('business_id', businessId)
    .in('status', ['pending', 'confirmed'])
    .eq('appointment_date', dateStr);
  
  // חשב slots לפי משך הפגישה
  const startHour = parseInt(dayAvailability.start_time.split(':')[0]);
  const startMinute = parseInt(dayAvailability.start_time.split(':')[1]);
  const endHour = parseInt(dayAvailability.end_time.split(':')[0]);
  const endMinute = parseInt(dayAvailability.end_time.split(':')[1]);
  const slotDuration = dayAvailability.slot_duration || 60; // ברירת מחדל 60 דקות
  
  // חישוב זמן התחלה וסיום בדקות
  const startTotalMinutes = startHour * 60 + startMinute;
  const endTotalMinutes = endHour * 60 + endMinute;
  
  for (let currentMinutes = startTotalMinutes; currentMinutes + slotDuration <= endTotalMinutes; currentMinutes += slotDuration) {
    const hour = Math.floor(currentMinutes / 60);
    const minute = currentMinutes % 60;
    
    const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
    
    // בדוק אם הזמן תפוס
    const isOccupied = existingAppointments?.some(apt => {
      const aptTime = apt.appointment_time.substring(0, 5); // HH:MM
      return aptTime === timeStr;
    });
    
    if (!isOccupied) {
      // בדוק שזה לא בעבר (אם זה היום)
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      
      if (dateStr === todayStr) {
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();
        
        if (hour < currentHour || (hour === currentHour && minute <= currentMinute)) {
          continue; // דלג על זמנים שכבר עברו
        }
      }
      
      slots.push({
        time: timeStr,
        duration: slotDuration
      });
    }
  }
  
  return slots;
}

// ========================================
// 📅 חישוב זמנים פנויים
// ========================================
async function calculateAvailableSlots(businessId, availability) {
  const slots = [];
  const now = new Date();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + 7); // שבוע קדימה
  
  // שלוף פגישות קיימות
  const { data: existingAppointments } = await supabase
    .from('appointments')
    .select('*')
    .eq('business_id', businessId)
    .in('status', ['pending', 'confirmed'])
    .gte('appointment_date', now.toISOString().split('T')[0])
    .lte('appointment_date', endDate.toISOString().split('T')[0]);
  
  // עבור על כל יום בשבוע הקרוב
  for (let d = new Date(now); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dayOfWeek = d.getDay();
    const dateStr = d.toISOString().split('T')[0];
    
    // מצא זמינות ליום זה
    const dayAvailability = availability.find(a => a.day_of_week === dayOfWeek);
    if (!dayAvailability) continue;
    
    // חשב slots לפי משך הפגישה
    const startHour = parseInt(dayAvailability.start_time.split(':')[0]);
    const startMinute = parseInt(dayAvailability.start_time.split(':')[1]);
    const endHour = parseInt(dayAvailability.end_time.split(':')[0]);
    const endMinute = parseInt(dayAvailability.end_time.split(':')[1]);
    
    for (let hour = startHour; hour < endHour; hour++) {
      for (let minute = 0; minute < 60; minute += dayAvailability.slot_duration) {
        // אם חורגים משעת הסיום
        if (hour === endHour - 1 && minute + dayAvailability.slot_duration > endMinute) break;
        
        const timeStr = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        
        // בדוק אם הזמן תפוס
        const isOccupied = existingAppointments?.some(apt => 
          apt.appointment_date === dateStr && 
          apt.appointment_time === timeStr + ':00'
        );
        
        if (!isOccupied) {
          // בדוק שזה לא בעבר
          const slotTime = new Date(`${dateStr}T${timeStr}:00`);
          if (slotTime > now) {
            slots.push({
              date: dateStr,
              time: timeStr,
              duration: dayAvailability.slot_duration
            });
          }
        }
      }
    }
  }
  
  return slots;
}

// ========================================
// 🔔 תזכורות יומיות
// ========================================
function scheduleDailyReminders() {
  // חשב כמה זמן עד 20:00
  const now = new Date();
  const tonight = new Date(now);
  tonight.setHours(18, 0, 0, 0);
  
  // אם כבר עברנו את 20:00, קבע למחר
  if (now > tonight) {
    tonight.setDate(tonight.getDate() + 1);
  }
  
  const msUntilTonight = tonight - now;
  
  // קבע טיימר ראשוני
  setTimeout(() => {
    sendDailyReminders();
    
    // ואז הפעל כל 24 שעות
    setInterval(sendDailyReminders, 24 * 60 * 60 * 1000);
  }, msUntilTonight);
  
  console.log(`⏰ תזכורות יומיות יופעלו ב-20:00 (בעוד ${Math.round(msUntilTonight / 1000 / 60)} דקות)`);
}

async function sendDailyReminders() {
  console.log('🔔 שולח תזכורות יומיות...');
  
  try {
    // מצא את כל הפגישות של מחר
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    
    const { data: appointments } = await supabase
      .from('appointments')
      .select('*, leads(*, businesses(*)), customers(*)')
      .eq('appointment_date', tomorrowStr)
      .in('status', ['confirmed', 'pending']);
    
    if (!appointments || appointments.length === 0) {
      console.log('📅 אין פגישות מחר');
      return;
    }
    
    console.log(`📅 נמצאו ${appointments.length} פגישות מחר`);
    
    // קבץ לפי עסק
    const appointmentsByBusiness = {};
    
    for (const appointment of appointments) {
      const businessId = appointment.business_id;
      if (!appointmentsByBusiness[businessId]) {
        appointmentsByBusiness[businessId] = {
          business: appointment.leads.businesses,
          appointments: []
        };
      }
      appointmentsByBusiness[businessId].appointments.push(appointment);
    }
    
    // שלח תזכורות לכל עסק
    for (const businessData of Object.values(appointmentsByBusiness)) {
      const { business, appointments } = businessData;
      
      // תזכורת לבעל העסק
      let ownerMessage = `🔔 *תזכורת - פגישות מחר*\n\n`;
      ownerMessage += `יש לך ${appointments.length} פגישות מחר:\n\n`;
      
      for (const apt of appointments) {
        ownerMessage += `⏰ *${apt.appointment_time.substring(0, 5)}*\n`;
        ownerMessage += `👤 ${apt.customers.name}\n`;
        ownerMessage += `📱 ${apt.customers.phone}\n`;
        ownerMessage += `📍 ${apt.location}\n`;
        ownerMessage += `━━━━━━━━━━━━━━━━\n`;
      }
      
      ownerMessage += `\n💪 בהצלחה!`;
      
      await sendWhatsAppMessage(business, normalizePhone(business.owner_phone), ownerMessage);
      
      // תזכורות ללקוחות
      for (const apt of appointments) {
        const customerMessage = `שלום ${apt.customers.name}! 👋\n\n` +
          `זוהי תזכורת על הפגישה שלך מחר:\n\n` +
          `📅 ${tomorrow.toLocaleDateString('he-IL')}\n` +
          `⏰ ${apt.appointment_time.substring(0, 5)}\n` +
          `📍 ${apt.location}\n` +
          `🔧 ${business.business_name}\n\n` +
          `נתראה מחר! 😊`;
        
        await sendWhatsAppMessage(business, apt.customers.phone, customerMessage);
      }
    }
    
    console.log('✅ תזכורות נשלחו בהצלחה');
    
  } catch (error) {
    console.error('❌ שגיאה בשליחת תזכורות:', error);
  }
}

// ========================================
// 🚀 Start Server
// ========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 WhatsCRM Server v2.1 FIXED running on port ${PORT}`);
  
  // הפעל תזכורות יומיות
  scheduleDailyReminders();
  console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook/whatsapp`);
  console.log(`🧠 Claude AI: ${process.env.ANTHROPIC_API_KEY ? 'Enabled ✅' : 'Disabled ❌'}`);
  console.log(`💾 Media Storage: Enabled ✅`);
  console.log(`🗑️ Auto Cleanup: Every 24 hours`);
  console.log(`🔧 Update: Fixed quote editing states - 16/10/2024`);
});
