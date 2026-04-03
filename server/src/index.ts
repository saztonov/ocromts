import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';
import { runMigrations } from './db/migrations.js';
import comparisonsRouter from './routes/comparisons.js';

// ---- Ensure required directories exist ---- //

fs.mkdirSync(config.UPLOADS_DIR, { recursive: true });

// ---- Database migrations ---- //

runMigrations();

// ---- Express app ---- //

const app = express();

app.use(cors());
app.use(express.json());

// ---- Multer configuration ---- //

/**
 * Multer disk storage that saves files into uploads/{comparisonId}/.
 * A new UUID is generated per upload request and embedded in the destination path.
 */
const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    // Generate a comparison ID once per request and cache it on the request object
    const reqWithId = _req as express.Request & { _comparisonId?: string };
    if (!reqWithId._comparisonId) {
      reqWithId._comparisonId = uuidv4();
    }

    const destDir = path.join(config.UPLOADS_DIR, reqWithId._comparisonId);
    fs.mkdirSync(destDir, { recursive: true });
    cb(null, destDir);
  },
  filename(_req, file, cb) {
    // Preserve the original filename (sanitize only null bytes)
    const safeName = file.originalname.replace(/\0/g, '');
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB per file
  },
  fileFilter(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowedExtensions = ['.xlsx', '.xls', '.pdf'];
    if (allowedExtensions.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${ext}. Allowed: .xlsx, .xls, .pdf`));
    }
  },
});

const uploadFields = upload.fields([
  { name: 'orderFile', maxCount: 1 },
  { name: 'invoiceFile', maxCount: 1 },
]);

// ---- Routes ---- //

// Apply multer middleware to the POST endpoint
app.use('/api/comparisons', (req, res, next) => {
  if (req.method === 'POST' && req.path === '/') {
    uploadFields(req, res, (err) => {
      if (err instanceof multer.MulterError) {
        console.error(`[upload] Multer error: ${err.message}, field: ${err.field}`);
        res.status(400).json({ error: `Upload error: ${err.message}` });
        return;
      }
      if (err) {
        console.error(`[upload] Error:`, (err as Error).message);
        res.status(400).json({ error: (err as Error).message });
        return;
      }
      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const fieldNames = files ? Object.keys(files) : [];
      console.log(`[upload] Received files: ${fieldNames.map(f => `${f} (${files![f][0]?.originalname})`).join(', ')}`);
      next();
    });
  } else {
    next();
  }
});

app.use('/api/comparisons', comparisonsRouter);

// ---- Health check ---- //

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ---- Error handling ---- //

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[server] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ---- Start server ---- //

app.listen(config.PORT, () => {
  console.log(`[server] Listening on http://localhost:${config.PORT}`);
  console.log(`[server] Uploads directory: ${config.UPLOADS_DIR}`);
  console.log(`[server] Database: ${config.DB_PATH}`);

  if (!config.OPENROUTER_API_KEY) {
    console.warn('[server] WARNING: OPENROUTER_API_KEY is not set. LLM calls will fail.');
  }
});

export default app;
