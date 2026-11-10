import "server-only";
import { getDocumentProxy } from "unpdf";
import { parseScanPdfItems, type ScanReport, type TextItem } from "./scan-report";

/** Read the positioned text out of an End of Show Scan Report PDF and parse it. */
export async function parseScanPdf(bytes: Uint8Array): Promise<ScanReport> {
  const pdf = await getDocumentProxy(bytes);
  const pages: TextItem[][] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    pages.push(
      (tc.items as any[])
        .filter((it) => typeof it.str === "string")
        .map((it) => ({ str: it.str as string, x: it.transform[4] as number, y: it.transform[5] as number })),
    );
  }
  return parseScanPdfItems(pages);
}
