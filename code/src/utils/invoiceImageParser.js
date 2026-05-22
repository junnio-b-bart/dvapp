import { createWorker } from "tesseract.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractInvoiceItemsFromLines } from "./invoicePdfParser.js";

const MONEY_RE = /(?:R\$\s*)?-?\s*(?:\d{1,3}(?:[.\s]\d{3})+|\d+)[,.]\d{2}/gi;
const INSTALLMENT_RE = /\b(?:PARC(?:ELA)?\s*)?(\d{1,2})\s*\/\s*(\d{1,2})\b/i;
const DATE_DD_MM_RE = /\b([0-3]?[0-9OoIl])\s*[/.-]\s*([01]?[0-9OoIl])(?:\s*[/.-]\s*(\d{2,4}))?\b/i;
const DATE_DD_MON_RE = /\b([0-3]?[0-9OoIl])\s*([A-Za-z]{3,9})\b/i;

const MONTH_TOKEN_TO_INDEX = {
  JAN: 0,
  JANEIRO: 0,
  FEV: 1,
  FEVEREIRO: 1,
  FEB: 1,
  MAR: 2,
  MARCO: 2,
  ABR: 3,
  ABRIL: 3,
  APR: 3,
  MAI: 4,
  MAIO: 4,
  MAY: 4,
  JUN: 5,
  JUNHO: 5,
  JUL: 6,
  JULHO: 6,
  AGO: 7,
  AGOSTO: 7,
  AUG: 7,
  SET: 8,
  SETEMBRO: 8,
  SEP: 8,
  OUT: 9,
  OUTUBRO: 9,
  OCT: 9,
  NOV: 10,
  NOVEMBRO: 10,
  DEZ: 11,
  DEZEMBRO: 11,
  DEC: 11,
};

const UI_NOISE_RE = /\b(FATURA|CARTOES|CARTÕES|TUDO|GRAFICO|GRÁFICO|PAGAR|PARCELAR|RECEBIDO|PAGAMENTO|ABRIL DE|MAIO DE)\b/i;

function normalizeLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeToken(text) {
  return normalizeLine(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function normalizeNumberToken(text) {
  return String(text || "")
    .replace(/[oO]/g, "0")
    .replace(/[lI]/g, "1");
}

function buildSafeDate(day, monthIndex, yearToken, invoiceMonthIndex, invoiceYear) {
  const yearNumber = Number(yearToken);
  const year = Number.isInteger(yearNumber) && yearToken
    ? yearNumber < 100
      ? 2000 + yearNumber
      : yearNumber
    : invoiceYear;

  if (!Number.isInteger(day) || !Number.isInteger(monthIndex) || !Number.isInteger(year)) {
    return null;
  }

  const date = new Date(year, monthIndex, day, 12, 0, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function parseImageDate(text, invoiceMonthIndex, invoiceYear) {
  const normalized = normalizeLine(text);
  const ddMmMatch = normalized.match(DATE_DD_MM_RE);
  if (ddMmMatch) {
    const day = Number(normalizeNumberToken(ddMmMatch[1]));
    const monthIndex = Number(normalizeNumberToken(ddMmMatch[2])) - 1;
    const date = buildSafeDate(day, monthIndex, ddMmMatch[3], invoiceMonthIndex, invoiceYear);
    if (date) return { date, token: ddMmMatch[0] };
  }

  const compact = normalized.replace(/\b([0-3]?[0-9OoIl])\s+([A-Za-z]{3,9})\b/g, "$1$2");
  const ddMonMatch = compact.match(DATE_DD_MON_RE);
  if (ddMonMatch) {
    const day = Number(normalizeNumberToken(ddMonMatch[1]));
    const monthToken = normalizeToken(ddMonMatch[2]);
    const monthIndex = MONTH_TOKEN_TO_INDEX[monthToken];
    const date = buildSafeDate(day, monthIndex, null, invoiceMonthIndex, invoiceYear);
    if (date) return { date, token: ddMonMatch[0] };
  }

  return null;
}

function toMoneyNumber(rawValue) {
  const raw = String(rawValue || "").replace(/[^\d,.-]/g, "");
  if (!raw) return 0;

  let normalized = raw.replace(/\s/g, "");
  const commaIndex = normalized.lastIndexOf(",");
  const dotIndex = normalized.lastIndexOf(".");
  const decimalIndex = Math.max(commaIndex, dotIndex);

  if (decimalIndex >= 0) {
    const integerPart = normalized.slice(0, decimalIndex).replace(/[.,]/g, "");
    const decimalPart = normalized.slice(decimalIndex + 1).replace(/[^\d]/g, "");
    normalized = `${integerPart}.${decimalPart}`;
  } else {
    normalized = normalized.replace(/[^\d-]/g, "");
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? Math.abs(value) : 0;
}

function extractAmount(text) {
  MONEY_RE.lastIndex = 0;
  const matches = [...String(text || "").matchAll(MONEY_RE)];
  if (!matches.length) return null;

  const raw = matches[matches.length - 1][0];
  const value = toMoneyNumber(raw);
  return value > 0 ? { raw, value } : null;
}

function parseInstallment(text) {
  const match = normalizeToken(text).match(INSTALLMENT_RE);
  if (!match) return { current: 1, total: 1, token: "" };

  const current = Math.max(1, Number(match[1]) || 1);
  const total = Math.max(current, Number(match[2]) || current);
  return { current, total, token: match[0] };
}

function parseTsvWords(tsv, pageNumber) {
  const rows = String(tsv || "")
    .split(/\r?\n/g)
    .map((row) => row.split("\t"))
    .filter((row) => row.length >= 12);

  return rows
    .filter((row) => row[0] === "5" && normalizeLine(row.slice(11).join(" ")))
    .map((row) => ({
      pageNumber,
      block: Number(row[2]) || 0,
      paragraph: Number(row[3]) || 0,
      line: Number(row[4]) || 0,
      word: Number(row[5]) || 0,
      left: Number(row[6]) || 0,
      top: Number(row[7]) || 0,
      width: Number(row[8]) || 0,
      height: Number(row[9]) || 0,
      confidence: Number(row[10]) || 0,
      text: normalizeLine(row.slice(11).join(" ")),
    }));
}

function rowsFromWords(words) {
  const buckets = new Map();

  for (const word of words || []) {
    if (!word.text) continue;
    const rowKey = [
      word.pageNumber,
      word.block,
      word.paragraph,
      word.line,
      Math.round((word.top || 0) / 8),
    ].join(":");

    if (!buckets.has(rowKey)) buckets.set(rowKey, []);
    buckets.get(rowKey).push(word);
  }

  return [...buckets.values()]
    .map((rowWords) => {
      const sortedWords = rowWords.sort((a, b) => a.left - b.left);
      const left = Math.min(...sortedWords.map((word) => word.left));
      const top = Math.min(...sortedWords.map((word) => word.top));
      const right = Math.max(...sortedWords.map((word) => word.left + word.width));
      const bottom = Math.max(...sortedWords.map((word) => word.top + word.height));
      const text = normalizeLine(sortedWords.map((word) => word.text).join(" "));
      return {
        pageNumber: sortedWords[0]?.pageNumber || 1,
        lineNumber: sortedWords[0]?.line || 1,
        words: sortedWords,
        text,
        left,
        right,
        top,
        bottom,
        centerY: (top + bottom) / 2,
      };
    })
    .filter((row) => row.text)
    .sort((a, b) => {
      if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
      return a.centerY - b.centerY;
    });
}

function cleanDescriptionLine(text, dateInfo, amountInfo) {
  let value = normalizeLine(text)
    .replace(/^[|\\/"'`.,:;()[\]{}]+/g, " ")
    .replace(/[|\\/"'`.,:;()[\]{}]+$/g, " ");

  if (dateInfo?.token) {
    value = value.replace(dateInfo.token, " ");
    value = value.replace(dateInfo.token.replace(/\s+/g, ""), " ");
  }

  if (amountInfo?.raw) value = value.replace(amountInfo.raw, " ");

  value = value
    .replace(MONEY_RE, " ")
    .replace(/\bR\$\b/gi, " ")
    .replace(/\bPARC(?:ELA)?\s*\d{1,2}\s*\/\s*\d{1,2}\b/gi, " ")
    .replace(/\bPARCELA\s*$/gi, " ")
    .replace(/\b[0-3]?[0-9OoIl]\s*(JAN|FEV|FEB|MAR|ABR|APR|MAI|MAY|JUN|JUL|AGO|AUG|SET|SEP|OUT|OCT|NOV|DEZ|DEC)\b/gi, " ")
    .replace(/\b(O|0)?\d{1,2}\s*ABR\b/gi, " ")
    .replace(/^[\s\-–—.:|]+/g, " ")
    .replace(/[\s\-–—.:|]+$/g, " ");

  value = normalizeLine(value);
  if (value.length < 3) return "";
  if (UI_NOISE_RE.test(value)) return "";
  if (/^[\W\d_]+$/i.test(value)) return "";
  return value;
}

function itemSignature(item) {
  const descriptionKey = normalizeToken(item.description).replace(/[^A-Z0-9]/g, "").slice(0, 28);
  return [
    String(item.purchaseDateIso || "").slice(0, 10),
    Number(item.installmentAmount || 0).toFixed(2),
    descriptionKey,
  ].join("|");
}

function mergeInvoiceItems(primaryItems, fallbackItems) {
  const merged = [];
  const seen = new Set();

  for (const item of [...(primaryItems || []), ...(fallbackItems || [])]) {
    if (!item?.purchaseDateIso || !item?.description || !(Number(item.installmentAmount) > 0)) {
      continue;
    }

    const signature = itemSignature(item);
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push(item);
  }

  return merged.sort((a, b) => {
    const byDate = new Date(b.purchaseDateIso).getTime() - new Date(a.purchaseDateIso).getTime();
    if (byDate !== 0) return byDate;
    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
    return a.lineNumber - b.lineNumber;
  });
}

function extractInvoiceItemsFromOcrWords(words, invoiceMonthIndex, invoiceYear, sourcePrefix) {
  const rows = rowsFromWords(words).filter((row) => !UI_NOISE_RE.test(row.text));
  const dateRows = rows
    .map((row) => ({
      ...row,
      dateInfo: parseImageDate(row.text, invoiceMonthIndex, invoiceYear),
    }))
    .filter((row) => row.dateInfo?.date);

  const items = [];

  for (let index = 0; index < dateRows.length; index += 1) {
    const anchor = dateRows[index];
    const previous = dateRows[index - 1];
    const next = dateRows[index + 1];
    const lowerBound = previous
      ? (previous.centerY + anchor.centerY) / 2
      : anchor.centerY - 95;
    const upperBound = next
      ? (anchor.centerY + next.centerY) / 2
      : anchor.centerY + 115;

    const blockRows = rows.filter((row) => (
      row.pageNumber === anchor.pageNumber &&
      row.centerY >= lowerBound &&
      row.centerY < upperBound
    ));

    const blockText = normalizeLine(blockRows.map((row) => row.text).join(" "));
    const amountCandidates = blockRows
      .map((row) => ({ row, amountInfo: extractAmount(row.text) }))
      .filter((entry) => entry.amountInfo);

    if (!amountCandidates.length) continue;

    const amountEntry = amountCandidates
      .sort((a, b) => {
        const aRightScore = a.row.right > anchor.right ? 1 : 0;
        const bRightScore = b.row.right > anchor.right ? 1 : 0;
        if (aRightScore !== bRightScore) return bRightScore - aRightScore;
        return b.row.right - a.row.right;
      })[0];

    const installment = parseInstallment(blockText);
    const description = blockRows
      .map((row) => cleanDescriptionLine(row.text, row === anchor ? anchor.dateInfo : null, amountEntry.amountInfo))
      .filter(Boolean)
      .join(" ");

    const normalizedDescription = normalizeLine(description);
    if (normalizedDescription.length < 3) continue;
    if (UI_NOISE_RE.test(normalizedDescription)) continue;

    items.push({
      key: `${sourcePrefix}-${anchor.pageNumber}-${anchor.lineNumber}-${items.length}`,
      pageNumber: anchor.pageNumber,
      lineNumber: anchor.lineNumber,
      purchaseDateIso: anchor.dateInfo.date.toISOString(),
      description: normalizedDescription,
      installmentNumber: installment.current,
      totalInstallments: installment.total,
      installmentAmount: amountEntry.amountInfo.value,
      rawLine: blockText,
    });
  }

  return mergeInvoiceItems(items, []);
}

function textLinesFromOcrData(data, pageNumber) {
  const pageLines = String(data?.text || "")
    .split(/\r?\n/g)
    .map((line) => normalizeLine(line))
    .filter(Boolean);

  return pageLines.map((line, lineIndex) => ({
    pageNumber,
    lineNumber: lineIndex + 1,
    line,
  }));
}

function createOcrWorker(onProgress) {
  return createWorker("por+eng", 1, {
    logger: (message) => {
      if (message?.status === "recognizing text") {
        onProgress?.(Number(message.progress || 0));
      }
    },
  });
}

async function configureWorker(worker) {
  await worker.setParameters({
    preserve_interword_spaces: "1",
  });
}

export async function parseInvoiceImageFiles(
  files,
  invoiceMonthIndex,
  invoiceYear,
  onProgress
) {
  const imageFiles = (files || []).filter(
    (file) => file && String(file.type || "").startsWith("image/")
  );

  if (imageFiles.length === 0) {
    return { items: [], pages: 0, lines: 0 };
  }

  const worker = await createOcrWorker(onProgress);
  const lines = [];
  const words = [];

  try {
    await configureWorker(worker);

    for (let fileIndex = 0; fileIndex < imageFiles.length; fileIndex += 1) {
      const imageFile = imageFiles[fileIndex];
      const pageNumber = fileIndex + 1;
      const { data } = await worker.recognize(imageFile, {}, { tsv: true });

      lines.push(...textLinesFromOcrData(data, pageNumber));
      words.push(...parseTsvWords(data?.tsv, pageNumber));
    }
  } finally {
    await worker.terminate();
  }

  const geometryItems = extractInvoiceItemsFromOcrWords(
    words,
    invoiceMonthIndex,
    invoiceYear,
    "img-ocr"
  );
  const fallbackItems = extractInvoiceItemsFromLines(
    lines,
    invoiceMonthIndex,
    invoiceYear,
    "img"
  );

  return {
    items: geometryItems.length ? geometryItems : fallbackItems,
    pages: imageFiles.length,
    lines: Math.max(lines.length, rowsFromWords(words).length),
  };
}

export async function parseInvoicePdfImagesWithOcr(
  file,
  invoiceMonthIndex,
  invoiceYear,
  onProgress
) {
  if (!file) {
    return { items: [], pages: 0, lines: 0 };
  }

  if (typeof document === "undefined") {
    return { items: [], pages: 0, lines: 0 };
  }

  const bytes = await file.arrayBuffer();
  const loadingTask = getDocument({ data: bytes });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;
  const worker = await createOcrWorker(onProgress);
  const lines = [];
  const words = [];

  try {
    await configureWorker(worker);

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d", { willReadFrequently: true });

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      if (!context) continue;

      await page.render({ canvasContext: context, viewport }).promise;

      const { data } = await worker.recognize(canvas, {}, { tsv: true });
      lines.push(...textLinesFromOcrData(data, pageNumber));
      words.push(...parseTsvWords(data?.tsv, pageNumber));
    }
  } finally {
    await worker.terminate();
    await pdf.destroy?.();
  }

  const geometryItems = extractInvoiceItemsFromOcrWords(
    words,
    invoiceMonthIndex,
    invoiceYear,
    "pdf-ocr-grid"
  );
  const fallbackItems = extractInvoiceItemsFromLines(
    lines,
    invoiceMonthIndex,
    invoiceYear,
    "pdf-ocr"
  );

  return {
    items: geometryItems.length ? geometryItems : fallbackItems,
    pages: pageCount,
    lines: Math.max(lines.length, rowsFromWords(words).length),
  };
}
