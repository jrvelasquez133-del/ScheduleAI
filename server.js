import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import multer from 'multer';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.json());

// Multer: solo PDF y Word, máx 10MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos PDF y Word (.docx)'));
    }
  }
});

// ── Función para extraer texto de archivos ──
async function extractText(file) {
  if (file.mimetype === 'application/pdf') {
    const data = await pdf(file.buffer);
    return data.text;
  }
  if (
    file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    file.mimetype === 'application/msword'
  ) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }
  return '';
}

// ── Función para llamar a Gemini ──
async function callGemini(systemPrompt, userMessage) {
  const apiKey = process.env.GEMINI_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_KEY no está configurada. Ve a Render → Environment y agrégala.');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userMessage }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1000 }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    console.error('Gemini API error:', data);
    throw new Error(data.error?.message || 'Error de Gemini API');
  }

  return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
}

// ── Endpoint: Chat sin archivo ──
app.post('/api/chat', async (req, res) => {
  try {
    const { system, message } = req.body;
    const rawText = await callGemini(system, message);
    res.json({ text: rawText });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Endpoint: Chat CON archivo (PDF/Word) ──
app.post('/api/chat-file', upload.single('file'), async (req, res) => {
  try {
    const { system, message } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ningún archivo.' });
    }

    // Extraer texto del archivo
    const fileText = await extractText(req.file);

    if (!fileText || fileText.trim().length === 0) {
      return res.status(400).json({ error: 'No se pudo extraer texto del archivo. Verifica que no esté vacío o protegido.' });
    }

    // Combinar el mensaje del usuario con el contenido del archivo
    const fullMessage = `${message}\n\n--- CONTENIDO DEL ARCHIVO "${req.file.originalname}" ---\n${fileText.substring(0, 15000)}`;

    const rawText = await callGemini(system, fullMessage);
    res.json({ text: rawText });

  } catch (err) {
    console.error('Chat-file error:', err);
    if (err.message.includes('Solo se permiten')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message || 'Error procesando el archivo.' });
  }
});

// ── Servir los archivos compilados de Vite ──
app.use(express.static(join(__dirname, 'dist')));

app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`ScheduleAI corriendo en puerto ${PORT}`);
});
