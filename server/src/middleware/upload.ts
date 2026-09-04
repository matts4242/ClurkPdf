import multer from 'multer';
import { ACCEPTED_MIME_TYPES, config } from '../config.js';
import { invalidFileType } from '../utils/errors.js';

/**
 * Multer configured for a single PDF, held in memory.
 *
 * Memory storage is deliberate at a 10MB ceiling: the request never touches
 * disk until the file has been accepted, so a rejected upload leaves nothing
 * to clean up and the final path is chosen by us rather than by the client.
 */
export const uploadSingleDocument = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxFileSize,
    files: 1,
    // Reject oversized field names and values before they are buffered.
    fieldNameSize: 100,
    fieldSize: 1024,
  },
  fileFilter: (_req, file, callback) => {
    if (!(ACCEPTED_MIME_TYPES as readonly string[]).includes(file.mimetype)) {
      callback(invalidFileType(file.mimetype));
      return;
    }
    callback(null, true);
  },
}).single('file');
