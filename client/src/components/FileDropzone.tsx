import { useCallback, useMemo, useState } from 'react';
import { useDropzone, type FileRejection } from 'react-dropzone';
import { AlertCircle, UploadCloud } from 'lucide-react';
import { formatBytes } from '../utils/format';

export interface FileDropzoneProps {
  onFilesSelected: (files: File[]) => void;
  /** Largest accepted file, in bytes. Defaults to 10MB, matching the server. */
  maxFileSize?: number;
  acceptedTypes?: string[];
  disabled?: boolean;
}

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;
const DEFAULT_ACCEPTED_TYPES = ['application/pdf'];

/**
 * Drag-and-drop target for PDFs.
 *
 * Files rejected here never reach the network; the server enforces the same
 * limits again, so this is convenience rather than the security boundary.
 */
export function FileDropzone({
  onFilesSelected,
  maxFileSize = DEFAULT_MAX_FILE_SIZE,
  acceptedTypes = DEFAULT_ACCEPTED_TYPES,
  disabled = false,
}: FileDropzoneProps) {
  const [rejectionMessage, setRejectionMessage] = useState<string | null>(null);

  const accept = useMemo(
    () => Object.fromEntries(acceptedTypes.map((type) => [type, ['.pdf']])),
    [acceptedTypes],
  );

  const onDrop = useCallback(
    (accepted: File[], rejected: FileRejection[]) => {
      if (rejected.length > 0) {
        setRejectionMessage(describeRejection(rejected, maxFileSize));
      } else {
        setRejectionMessage(null);
      }

      // Accepted files go straight into the parent's upload queue, which shows
      // the name, size, and progress. Holding a second copy here would list
      // every file twice.
      if (accepted.length > 0) onFilesSelected(accepted);
    },
    [maxFileSize, onFilesSelected],
  );

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    accept,
    maxSize: maxFileSize,
    multiple: true,
    disabled,
  });

  const borderClass = isDragReject
    ? 'border-rose-400 bg-rose-50'
    : isDragActive
      ? 'border-sky-500 bg-sky-50'
      : 'border-slate-300 bg-white hover:border-slate-400';

  return (
    <div className="space-y-3">
      <div
        {...getRootProps()}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${borderClass} ${
          disabled ? 'cursor-not-allowed opacity-60' : ''
        }`}
        aria-label="Upload PDF invoices"
      >
        <input {...getInputProps()} />
        <UploadCloud
          className={`h-8 w-8 ${isDragActive ? 'text-sky-600' : 'text-slate-400'}`}
          aria-hidden="true"
        />
        <p className="text-sm font-medium text-slate-700">
          {isDragActive ? 'Drop to upload' : 'Drag PDFs here, or click to browse'}
        </p>
        <p className="text-xs text-slate-500">
          PDF only, up to {formatBytes(maxFileSize)} each
        </p>
      </div>

      {rejectionMessage !== null && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{rejectionMessage}</span>
        </p>
      )}

    </div>
  );
}

function describeRejection(rejections: FileRejection[], maxFileSize: number): string {
  const first = rejections[0];
  if (!first) return 'That file could not be accepted.';

  const code = first.errors[0]?.code;
  if (code === 'file-too-large') {
    return `${first.file.name} is ${formatBytes(first.file.size)}, over the ${formatBytes(maxFileSize)} limit.`;
  }
  if (code === 'file-invalid-type') {
    return `${first.file.name} is not a PDF. Only PDF files are accepted.`;
  }
  return `${first.file.name} could not be accepted.`;
}
