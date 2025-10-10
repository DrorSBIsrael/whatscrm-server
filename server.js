// server.js - WhatsCRM Webhook Server
require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
app.use(express.json());

// חיבור ל-Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // שימו לב: SERVICE KEY ולא ANON KEY!
);

// ========================================
// 💬 יצירת הודעת קבלה מותאמת אישית
// ========================================
function generateWelcomeMessage(business) {
  // אם יש תבנית מותאמת - השתמש בה
  if (business.response_template) {
    return business.response_template
      .replace('{owner_name}', business.owner_name)
      .replace('{business_name}', business.business_name)
      .replace('{service_type}', business.service_type || 'שירותי תחזוקה')
      .replace('{service_area}', business.service_area || 'המרכז');
  }
  
  // תבנית ברירת מחדל
  return `שלום! אני ${business.owner_name} מ-${business.business_name} 👋

${business.service_description ? business.service_description : 'אנחנו כאן לעזור לך!'}

קיבלתי את הפנייה שלך! 
האם תוכל לשלוח תמונה של הבעיה כדי שאוכל להכין הצעת מחיר?`;
}

// ========================================
// 🎯 Webhook Endpoint - מקבל הודעות מ-Green API
// ========================================
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    console.log('📨 קיבלתי webhook:', JSON.stringify(req.body, null, 2));

    const { typeWebhook, senderData, messageData, instanceData } = req.body;

    // בדוק שזו הודעה נכנסת (לא יוצאת)
    if (typeWebhook !== 'incomingMessageReceived') {
      return res.status(200).send('OK - not a message');
    }

    // שלוף מידע
    const phoneNumber = senderData.sender.replace('@c.us', ''); // מספר הלקוח
    const instanceId = instanceData.idInstance; // מזהה ה-WhatsApp Business

    // זיהוי סוג ההודעה
    let messageText = '';
    let mediaUrl = null;
    let mediaType = null;

    if (messageData.typeMessage === 'textMessage') {
      // הודעת טקסט רגילה
      messageText = messageData.textMessageData?.textMessage || '';
    } else if (messageData.typeMessage === 'imageMessage') {
      // תמונה
      messageText = messageData.fileMessageData?.caption || 'תמונה';
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      mediaType = 'image';
      console.log('📷 התקבלה תמונה:', mediaUrl);
    } else if (messageData.typeMessage === 'videoMessage') {
      // וידאו
      messageText = messageData.fileMessageData?.caption || 'וידאו';
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      mediaType = 'video';
      console.log('🎥 התקבל וידאו:', mediaUrl);
    } else if (messageData.typeMessage === 'documentMessage') {
      // מסמך/קובץ
      messageText = messageData.fileMessageData?.caption || 'קובץ';
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      mediaType = 'document';
      console.log('📎 התקבל קובץ:', mediaUrl);
    }

    console.log(`💬 הודעה מ-${phoneNumber}: ${messageText}`);

    // מצא את העסק לפי instance ID
    const business = await findBusinessByInstance(instanceId);
    if (!business) {
      console.log('❌ לא נמצא עסק עם instance זה');
      return res.status(200).send('OK - no business');
    }

    console.log(`✅ עסק נמצא: ${business.business_name}`);

    // טפל בהודעה (כולל מדיה)
    await handleIncomingMessage(business, phoneNumber, messageText, mediaUrl, mediaType);

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
// 💬 טפל בהודעה נכנסת
// ========================================
async function handleIncomingMessage(business, phoneNumber, messageText) {
  // 1. בדוק אם הלקוח קיים
  let customer = await findCustomer(business.id, phoneNumber);

  if (!customer) {
    console.log('🆕 לקוח חדש - יוצר...');
    customer = await createCustomer(business.id, phoneNumber);
  } else {
    console.log(`✅ לקוח קיים: ${customer.name}`);
  }

  // 2. בדוק אם יש פנייה פתוחה
  let lead = await findOpenLead(customer.id);

  if (!lead) {
    console.log('🆕 פנייה חדשה - יוצר...');
    lead = await createLead(business.id, customer.id, messageText);

    // שלח הודעת קבלה מותאמת אישית
    const welcomeMessage = generateWelcomeMessage(business);
    await sendWhatsAppMessage(business, phoneNumber, welcomeMessage);

    // התראה לבעל העסק
    await notifyBusinessOwner(business, customer, lead);

  } else {
    console.log(`✅ פנייה קיימת: ${lead.id}`);

    // עדכן את תיאור הפנייה
    await updateLeadDescription(lead.id, messageText);

    // נסה למצוא מוצרים מתאימים
    const matchedProducts = await matchProducts(business.id, messageText);

    if (matchedProducts.length > 0) {
      console.log(`🎯 נמצאו ${matchedProducts.length} מוצרים מתאימים`);

      // צור הצעת מחיר אוטומטית (טיוטה)
      const quote = await createAutoQuote(lead.id, matchedProducts);

      // התראה לבעל העסק לאשר
      await notifyQuoteApproval(business, customer, quote);

    } else {
      console.log('⚠️ לא נמצאו מוצרים - דורש טיפול ידני');
    }
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
      name: `לקוח ${phone.slice(-4)}`, // שם זמני
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
  const { data } = await supabase
    .from('leads')
    .select('*')
    .eq('customer_id', customerId)
    .in('status', ['new', 'quoted', 'approved'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  return data;
}

// ========================================
// 🆕 צור פנייה חדשה
// ========================================
async function createLead(businessId, customerId, description) {
  const { data, error } = await supabase
    .from('leads')
    .insert({
      business_id: businessId,
      customer_id: customerId,
      service_description: description,
      status: 'new',
    })
    .select()
    .single();

  if (error) {
    console.error('שגיאה ביצירת פנייה:', error);
    return null;
  }

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
// 🎯 התאם מוצרים לתיאור
// ========================================
async function matchProducts(businessId, description) {
  // שלוף מוצרים פעילים
  const { data: products } = await supabase
    .from('products')
    .select('*')
    .eq('business_id', businessId)
    .eq('is_active', true);

  if (!products || products.length === 0) return [];

  // ניקוד פשוט לפי מילות מפתח
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

  // החזר רק מוצרים עם ציון > 0
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
      status: 'pending_approval', // ממתין לאישור
    })
    .select()
    .single();

  if (error) {
    console.error('שגיאה ביצירת הצעה:', error);
    return null;
  }

  return quote;
}

function generateQuoteText(products) {
  let text = 'הצעת מחיר:\n\n';
  products.forEach((p, i) => {
    text += `${i + 1}. ${p.name} - ₪${p.base_price}\n`;
  });
  const total = products.reduce((sum, p) => sum + parseFloat(p.base_price), 0);
  text += `\nסה"כ: ₪${total}`;
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
// 🔔 התראות (TODO: Push Notifications)
// ========================================
async function notifyBusinessOwner(business, customer, lead) {
  console.log(`🔔 התראה לבעל עסק: פנייה חדשה מ-${customer.phone}`);
  // TODO: שלח Push Notification לאפליקציה
}

async function notifyQuoteApproval(business, customer, quote) {
  console.log(`🔔 התראה: הצעה מוכנה לאישור - ₪${quote.amount}`);
  // TODO: שלח Push Notification
}

// ========================================
// 🏠 Health Check
// ========================================
app.get('/', (req, res) => {
  res.send('✅ WhatsCRM Webhook Server is running!');
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// ========================================
// 🚀 Start Server
// ========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook/whatsapp`);
});
