# Pharmacy pilot kit

Everything you need to run a small, honest pilot with real pharmacies: who to approach, what to say, how they join, and what to measure. Aim for **2–3 pharmacies within 2 km of each other** (one neighbourhood, e.g. Vaishali Nagar) for **two weeks**.

## 1. Who to approach

| Good fit | Why |
| --- | --- |
| Independent chemists (not big chains) | They decide on the spot, and walk-ins matter to them |
| Owner or pharmacist uses Telegram or WhatsApp daily | Answering takes one tap on the phone they already use |
| Busy counter with a range of medicines | More requests, more learning |
| 2–3 shops close together | A customer's request reaches more than one shop, so you can see the comparison and split working |

Go in person at a quiet time (mid-morning or mid-afternoon). Bring the printed one-page guide (`docs/pilot/pharmacist-guide.pdf`) and your phone with the bot open (https://t.me/MediFast2_bot).

## 2. What to say

**English (30 seconds)**

> Hello, I'm a final-year CSE student at JECRC University. We built a free Telegram tool called MediFast. When someone nearby needs medicines, it sends you their list, and you just tap whether you have each one. If they choose your shop, they come with a 4-digit code and pay you at the counter. There's no app, no stock entry, no fees, and you can pause it any time. Could we try it with your shop for two weeks?

**हिंदी (30 सेकंड)**

> नमस्ते, मैं JECRC University में CSE अंतिम वर्ष का छात्र हूँ। हमने MediFast नाम का एक मुफ़्त Telegram टूल बनाया है। जब आस-पास किसी को दवाइयाँ चाहिए होती हैं, तो उनकी लिस्ट आपके पास आती है, और आपको बस हर दवा के लिए एक बटन दबाना होता है कि आपके पास है या नहीं। अगर ग्राहक आपकी दुकान चुनता है, तो वह 4 अंकों का कोड लेकर आता है और काउंटर पर ही भुगतान करता है। कोई ऐप नहीं, कोई स्टॉक एंट्री नहीं, कोई फ़ीस नहीं, और आप जब चाहें इसे बंद कर सकते हैं। क्या हम दो हफ़्ते आपकी दुकान के साथ इसे आज़मा सकते हैं?

**Message to send afterwards (WhatsApp or Telegram)**

> Thank you for agreeing to try MediFast! Open this link in Telegram: https://t.me/MediFast2_bot?start=partner. It asks for your shop name, location, counter phone and drug licence number. After we verify the licence you'll start receiving requests. Send /close any time to pause, and /open to resume. — <Your name>, <phone>

## 3. Questions they will ask

| Question | Answer |
| --- | --- |
| Does it cost anything? | No. It's a free student pilot. |
| Do I have to update stock? | Never. You answer only when a real request comes. |
| What if I'm busy? | Ignore it, or send `/close`. Other shops answer. |
| Do you sell medicines online? | No. The customer pays you at the counter. You check the prescription as usual. |
| Will customers see my phone number? | Yes, the counter number you give, so they can call. Their personal details aren't shared with you until they reserve (first name only). |
| What about Schedule H / prescription medicines? | They're marked ℞. You check the prescription at handover, as you do today. Habit-forming medicines are never sent out. |
| Can you swap a brand for me? | You can mark 🔁 "alternative brand". The customer decides at the counter. |

## 4. Onboarding checklist (per pharmacy)

| ✓ | Step |
| --- | --- |
| ☐ | Owner agreed verbally to a two-week pilot; you explained what is shared |
| ☐ | Pharmacy opened the `?start=partner` link and completed the 4 questions |
| ☐ | You checked the **drug licence number** (on the certificate displayed in the shop) before tapping **Approve** |
| ☐ | Test request sent from your own phone; pharmacist answered it once with you present |
| ☐ | Pharmacist knows `/close`, `/open` and `/desk` |
| ☐ | Printed one-page guide left at the counter |

## 5. What to measure (for your report)

Run the pilot for two weeks, then record these numbers, which the system already tracks (`/desk` per shop, `/admin` overall):

| Metric | Where it comes from | Why it matters |
| --- | --- | --- |
| Requests sent | `/admin` | Demand |
| Answer rate per pharmacy | `/desk` → "answered" | Will pharmacists actually respond? |
| Median time to answer | `/desk` → "median reply" | Is it fast enough to be useful? |
| Requests with ≥1 reservable answer | Board / admin | Does it solve the problem? |
| Reservations collected vs. declined | `/desk` | Do answers turn into real pickups? |
| Pharmacist feedback (3 questions below) | Short chat at the end | Would they keep using it? |

**Feedback questions for pharmacists at the end:**
1. On a scale of 1–5, how easy was answering a request?
2. Did any customer come in because of MediFast? Roughly how many?
3. Would you keep using it if it stayed free? What would you change?

Report the real numbers, even small ones ("3 pharmacies, 21 requests, 17 answered, median 2 min 10 s"). Real data from 3 shops is worth more in a viva than simulated data from 300.

## 6. Ethics and safety

- Tell pharmacists and test customers clearly that this is a **student pilot**.
- Use only **your own and your friends' phones** as customers during the pilot, with real medicine names but no real personal health information.
- Never pressure a pharmacist to answer, and don't publish shop names in your report without permission.
- Set `DEMO_MODE=false` on the live deployment during the pilot so real requests only reach real, approved shops.
