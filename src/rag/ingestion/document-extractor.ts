import { z } from 'zod';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const extractedPageSchema = z
  .object({
    pageNumber: z.number().int().positive(),
    text: z.string(),
    textCharacterCount: z.number().int().nonnegative(),
    extractionMethod: z.enum(['embedded_text', 'ocr_tesseract']),
    confidence: z.number().min(0).max(1).nullable(),
  })
  .strict();

export const extractedDocumentSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    documentId: z.string().regex(/^legal_[a-f0-9]{24}$/),
    sourceSha256: sha256Schema,
    extractor: z.enum(['pdfjs-dist', 'pdfjs-dist+tesseract', 'pypdf', 'pypdf+tesseract']),
    extractedAt: z.string().datetime({ offset: true }),
    pageCount: z.number().int().positive(),
    status: z.enum(['extracted', 'ocr_required']),
    pages: z.array(extractedPageSchema),
    warnings: z.array(z.string().trim().min(1)),
  })
  .strict()
  .superRefine((document, context) => {
    if (document.pages.length !== document.pageCount) {
      context.addIssue({
        code: 'custom',
        path: ['pages'],
        message: 'Page count does not match extracted pages',
      });
    }
    document.pages.forEach((page, index) => {
      if (page.pageNumber !== index + 1) {
        context.addIssue({
          code: 'custom',
          path: ['pages', index, 'pageNumber'],
          message: 'Pages must be sequential',
        });
      }
    });
  });

export type ExtractedPage = z.infer<typeof extractedPageSchema>;
export type ExtractedDocument = z.infer<typeof extractedDocumentSchema>;

export function assertExtractionSource(
  document: ExtractedDocument,
  documentId: string,
  sourceSha256: string,
): void {
  if (document.documentId !== documentId || document.sourceSha256 !== sourceSha256)
    throw new Error('Cached extraction identity does not match the requested source');
}

export interface ExtractionRequest {
  documentId: string;
  sourcePath: string;
  sourceSha256: string;
}

export interface DocumentExtractor {
  extract(request: ExtractionRequest): Promise<ExtractedDocument>;
}
