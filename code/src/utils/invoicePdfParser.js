import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerSrc from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

const DATE_DDMM_RE = /\b(\d{1,2})\s*[/.-]\s*(\d{1,2})(?:\s*[/.-]\s*(\d{2,4}))?\b/;
const DATE_DD_MON_RE = /\b(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(\d{2,4}))?\b/;
const DAY_START_RE = /^\s*([0-3]?[0-9OoIl]{1,2})\b/;
const MONEY_RE = /(?:R\$\s*)?-?(?:\d{1,3}(?:[.\s]\d{3})+|\d+)(?:[.,]\d{2})?/gi;
const INSTALLMENT_SLASH_RE = /\b(\d{1,2})\s*\/\s*(\d{1,2})\b/gi;
const INSTALLMENT_TEXT_RE = /\bPARC(?:ELA)?\s*(\d{1,2})\s*(?:DE|\/)\s*(\d{1,2})\b/i;

const IGNORED_KEYWORDS = [
  "PAGAMENTO",
  "TOTAL",
  "LIMITE",
  "VENCIMENTO",
  "ENCARGOS",
  "JUROS",
  "MULTA",
  "IOF",
  "ESTORNO",
  "CREDITO",
  "SALDO",
  "FATURA DO CARTAO",
  "DESCRICAO",
  "DATA",
  "VALOR",
  "VOLTAR AO TOPO",
  "PAGINA",   // "Pagina 1", "Pagina 2" — marcadores de página
  "SUBTOTAL",
  "TOTAL DA FATURA",
];

const MONTH_TOKEN_TO_INDEX = {
  JAN: 0,
  JANEIRO: 0,
  FEV: 1,
  FEVEREIRO: 1,
  FEB: 1,
  MAR: 2,
  MARCO: 2,
  MARCH: 2,
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

function normalizeLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizeToken(text) {
  return normalizeLine(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function toMoneyNumber(value) {
  const raw = String(value || "").replace(/[^\d,.-]/g, "");
  if (!raw) return 0;

  const hasComma = raw.includes(",");
  const hasDot = raw.includes(".");
  let normalized = raw;

  if (hasComma && hasDot) {
    normalized = raw.replace(/\./g, "").replace(",", ".");
  } else if (hasComma) {
    normalized = raw.replace(",", ".");
  } else if (hasDot) {
    const parts = raw.split(".");
    const lastPart = parts[parts.length - 1] || "";
    if (lastPart.length !== 2) {
      normalized = raw.replace(/\./g, "");
    }
  }

  let parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return 0;

  // OCR frequently drops comma from cents: "590" -> "5,90", "8410" -> "84,10"
  if (!hasComma && !hasDot && /^\d{3,}$/.test(raw)) {
    parsed = parsed / 100;
  }

  return Number.isFinite(parsed) ? parsed : 0;
}

function resolveYear(yearToken, monthIndex, invoiceMonthIndex, invoiceYear) {
  let year = invoiceYear;
  if (yearToken) {
    year = yearToken.length === 2 ? 2000 + Number(yearToken) : Number(yearToken);
  } else if (monthIndex > invoiceMonthIndex) {
    year = invoiceYear - 1;
  }
  return year;
}

function buildSafeDate(day, monthIndex, yearToken, invoiceMonthIndex, invoiceYear) {
  const year = resolveYear(yearToken, monthIndex, invoiceMonthIndex, invoiceYear);
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

function parseMonthInLine(line) {
  const tokens = normalizeToken(line).split(/\s+/g).filter(Boolean);
  for (const token of tokens) {
    if (MONTH_TOKEN_TO_INDEX[token] != null) {
      return MONTH_TOKEN_TO_INDEX[token];
    }
  }
  return null;
}

function parseDayStartInLine(line) {
  const match = String(line || "").match(DAY_START_RE);
  if (!match) return null;

  const token = String(match[1] || "")
    .replace(/[oO]/g, "0")
    .replace(/[lI]/g, "1");

  const day = Number(token);
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  return day;
}

function parseDateInLine(line, invoiceMonthIndex, invoiceYear) {
  // Verifica PRIMEIRO o formato "16 ABR" (dia + nome do mês) — é inequívoco
  // e evita que padrões como "2/3" (parcelas) sejam capturados como datas.
  const ddMonMatch = line.match(DATE_DD_MON_RE);
  if (ddMonMatch) {
    const day = Number(ddMonMatch[1]);
    const monthToken = normalizeToken(ddMonMatch[2]);
    const monthIndex = MONTH_TOKEN_TO_INDEX[monthToken];
    if (Number.isInteger(monthIndex)) {
      const yearToken = ddMonMatch[3];
      const date = buildSafeDate(day, monthIndex, yearToken, invoiceMonthIndex, invoiceYear);
      if (date) {
        return { date, token: ddMonMatch[0] };
      }
    }
  }

  // Só tenta formato numérico "16/04" se não encontrou formato com nome de mês
  const ddMmMatch = line.match(DATE_DDMM_RE);
  if (ddMmMatch) {
    const day = Number(ddMmMatch[1]);
    const monthIndex = Number(ddMmMatch[2]) - 1;
    const yearToken = ddMmMatch[3];
    const date = buildSafeDate(day, monthIndex, yearToken, invoiceMonthIndex, invoiceYear);
    if (date) {
      return { date, token: ddMmMatch[0] };
    }
  }

  return null;
}

function parseInstallmentFromLine(line, dateToken) {
  const textMatch = line.match(INSTALLMENT_TEXT_RE);
  if (textMatch) {
    const current = Math.max(1, Number(textMatch[1]) || 1);
    const total = Math.max(current, Number(textMatch[2]) || current);
    return {
      installmentNumber: current,
      totalInstallments: total,
      token: textMatch[0],
    };
  }

  const normalizedDateToken = normalizeLine(dateToken || "");
  INSTALLMENT_SLASH_RE.lastIndex = 0;
  const slashMatches = [...String(line || "").matchAll(INSTALLMENT_SLASH_RE)];
  for (const slashMatch of slashMatches) {
    const token = normalizeLine(slashMatch?.[0] || "");
    if (!token) continue;

    // Avoid reading dates like "15/04" as installments.
    if (normalizedDateToken && normalizedDateToken.includes(token)) {
      continue;
    }

    const current = Math.max(1, Number(slashMatch[1]) || 1);
    const totalCandidate = Number(slashMatch[2]) || current;
    if (totalCandidate < current) continue;

    const total = Math.max(current, totalCandidate);
    return {
      installmentNumber: current,
      totalInstallments: total,
      token: slashMatch[0],
    };
  }

  return null;
}

function normalizeDescription(text) {
  return normalizeLine(
    String(text || "")
      .replace(/[\u2022\u00B7\u25AA\u25CF\u25E6]/g, " ")
      .replace(/[<>]/g, " ")
      .replace(/\bR\$\b/gi, " ")
      .replace(/^[\s/.-]*\d{1,2}\s*[/.-]\s*\d{2,4}\b/g, " ")
      .replace(/^[\s/.-]*\d{1,2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{2,4}\b/g, " ")
      .replace(/^[\s\-–—.:|]+/g, " ")
      .replace(/[\s\-–—.:|]+$/g, " ")
  );
}

function shouldIgnoreDescription(description) {
  const upper = normalizeToken(description);
  if (upper.length < 3) return true;
  if (/^[\d.,\s]+$/.test(upper)) return true; // purely numeric like "145,53" or "1 2"
  return IGNORED_KEYWORDS.some((keyword) => upper.includes(keyword));
}

function canAttachInstallment(candidate, lastItem) {
  if (!lastItem) return false;
  if (Number(candidate?.pageNumber || 1) !== Number(lastItem.pageNumber || 1)) return false;
  const diff = Number(candidate?.lineNumber || 0) - Number(lastItem.lineNumber || 0);
  return diff >= 0 && diff <= 3;
}

function buildTextLines(textItems) {
  const buckets = new Map();

  for (const item of textItems || []) {
    const value = normalizeLine(item?.str || "");
    if (!value) continue;

    const x = Number(item?.transform?.[4] || 0);
    const y = Number(item?.transform?.[5] || 0);
    const rowKey = Math.round(y * 2) / 2;

    if (!buckets.has(rowKey)) buckets.set(rowKey, []);
    buckets.get(rowKey).push({ x, value });
  }

  const rows = [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, parts]) =>
      parts
        .sort((a, b) => a.x - b.x)
        .map((part) => part.value)
        .join(" ")
    )
    .map((line) => normalizeLine(line))
    .filter(Boolean);

  return rows;
}

export function extractInvoiceItemsFromLines(
  lines,
  invoiceMonthIndex,
  invoiceYear,
  sourcePrefix = "src"
) {
  const items = [];
  const seen = new Set();
  const pendingItemsWithoutMonth = [];

  let currentMonthIndex = Number.isInteger(invoiceMonthIndex) ? invoiceMonthIndex : null;
  let currentDay = null;
  let currentDateContext = null;
  let lastItem = null;

  function attachMonthToPending(monthIndex, candidate) {
    if (!Number.isInteger(monthIndex)) return;

    for (let i = pendingItemsWithoutMonth.length - 1; i >= 0; i -= 1) {
      const item = pendingItemsWithoutMonth[i];
      if (!item || item._monthAssigned) continue;
      if (item.pageNumber !== Number(candidate?.pageNumber || 1)) continue;

      const lineDiff = Number(candidate?.lineNumber || 0) - Number(item.lineNumber || 0);
      if (lineDiff < 0 || lineDiff > 3) continue;

      const guessedDate = buildSafeDate(
        item._dayGuess,
        monthIndex,
        null,
        invoiceMonthIndex,
        invoiceYear
      );
      if (!guessedDate) continue;

      item.purchaseDateIso = guessedDate.toISOString();
      item._monthAssigned = true;
      currentMonthIndex = guessedDate.getMonth();
      currentDay = guessedDate.getDate();
      currentDateContext = guessedDate;
    }
  }

  for (const candidate of lines || []) {
    const normalized = normalizeLine(candidate?.line || "");
    if (!normalized) continue;

    const pageNumber = Number(candidate?.pageNumber || 1);
    const lineNumber = Number(candidate?.lineNumber || 1);

    const monthInLine = parseMonthInLine(normalized);
    if (Number.isInteger(monthInLine)) {
      currentMonthIndex = monthInLine;
      attachMonthToPending(monthInLine, candidate);
    }

    const dayInLine = parseDayStartInLine(normalized);
    if (Number.isInteger(dayInLine)) {
      currentDay = dayInLine;
    }

    const dateInfo = parseDateInLine(normalized, invoiceMonthIndex, invoiceYear);
    if (dateInfo?.date) {
      currentDateContext = dateInfo.date;
      currentMonthIndex = dateInfo.date.getMonth();
      currentDay = dateInfo.date.getDate();
    }

    const installmentInfo = parseInstallmentFromLine(normalized, dateInfo?.token);
    // Strip installment token before looking for money — prevents "01/12 103,75" → 12103.75
    const lineForMoney = installmentInfo?.token
      ? normalized.replace(installmentInfo.token, " ")
      : normalized;
    const moneyMatches = [...lineForMoney.matchAll(MONEY_RE)];
    const hasMoney = moneyMatches.length > 0;

    if (installmentInfo && !hasMoney && canAttachInstallment(candidate, lastItem)) {
      lastItem.installmentNumber = installmentInfo.installmentNumber;
      lastItem.totalInstallments = installmentInfo.totalInstallments;
      if (!lastItem._monthAssigned && Number.isInteger(monthInLine)) {
        attachMonthToPending(monthInLine, candidate);
      }
      continue;
    }

    if (!hasMoney) {
      if (!dateInfo?.date && Number.isInteger(dayInLine) && Number.isInteger(currentMonthIndex)) {
        const guessed = buildSafeDate(dayInLine, currentMonthIndex, null, invoiceMonthIndex, invoiceYear);
        if (guessed) {
          currentDateContext = guessed;
        }
      }
      continue;
    }

    const rawAmount = moneyMatches[moneyMatches.length - 1][0];
    const amount = toMoneyNumber(rawAmount);
    if (!(amount > 0)) continue;

    const dayGuess = Number.isInteger(dayInLine)
      ? dayInLine
      : Number.isInteger(currentDay)
        ? currentDay
        : null;

    let purchaseDate = dateInfo?.date || currentDateContext || null;
    if (!purchaseDate && Number.isInteger(dayGuess) && Number.isInteger(currentMonthIndex)) {
      purchaseDate = buildSafeDate(dayGuess, currentMonthIndex, null, invoiceMonthIndex, invoiceYear);
    }
    if (!purchaseDate && Number.isInteger(dayGuess)) {
      purchaseDate = buildSafeDate(dayGuess, invoiceMonthIndex, null, invoiceMonthIndex, invoiceYear);
    }
    if (!purchaseDate) continue;

    let description = normalized;
    // Strip full date token first (e.g. "16/03"); only fall back to day-only if no full token
    if (dateInfo?.token) {
      description = description.replace(dateInfo.token, " ");
    } else if (dayInLine != null) {
      description = description.replace(DAY_START_RE, " ");
    }
    description = description.replace(rawAmount, " ");
    if (installmentInfo?.token) {
      description = description.replace(installmentInfo.token, " ");
    }

    description = normalizeDescription(description);
    if (description.length < 2) continue;
    if (shouldIgnoreDescription(description)) continue;

    const purchaseDateIso = purchaseDate.toISOString();
    const signature = [
      purchaseDateIso.slice(0, 10),
      description.toLowerCase(),
      amount.toFixed(2),
      normalized.toLowerCase(),
    ].join("|");

    if (seen.has(signature)) continue;
    seen.add(signature);

    const monthWasExplicit = Boolean(dateInfo?.date) || Number.isInteger(monthInLine);

    const item = {
      key: `${sourcePrefix}-${pageNumber}-${lineNumber}-${items.length}`,
      pageNumber,
      lineNumber,
      purchaseDateIso,
      description,
      installmentNumber: installmentInfo?.installmentNumber || 1,
      totalInstallments: installmentInfo?.totalInstallments || 1,
      installmentAmount: amount,
      rawLine: normalized,
      _dayGuess: dayGuess,
      _monthAssigned: monthWasExplicit,
    };

    if (!monthWasExplicit && Number.isInteger(dayGuess)) {
      pendingItemsWithoutMonth.push(item);
    }

    items.push(item);
    currentDateContext = purchaseDate;
    currentMonthIndex = purchaseDate.getMonth();
    currentDay = purchaseDate.getDate();
    lastItem = item;
  }

  items.sort((a, b) => {
    const byDate = new Date(b.purchaseDateIso).getTime() - new Date(a.purchaseDateIso).getTime();
    if (byDate !== 0) return byDate;
    if (a.pageNumber !== b.pageNumber) return a.pageNumber - b.pageNumber;
    return a.lineNumber - b.lineNumber;
  });

  return items.map((item) => {
    const { _dayGuess, _monthAssigned, ...clean } = item;
    return clean;
  });
}

export async function parseInvoicePdfFile(file, invoiceMonthIndex, invoiceYear) {
  if (!file) {
    return { items: [], pages: 0, lines: 0 };
  }

  const bytes = await file.arrayBuffer();
  const loadingTask = getDocument({ data: bytes });
  const pdf = await loadingTask.promise;

  const lines = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent({
      normalizeWhitespace: true,
      disableCombineTextItems: false,
    });
    const pageLines = buildTextLines(textContent.items);
    pageLines.forEach((line, index) => {
      lines.push({
        pageNumber,
        lineNumber: index + 1,
        line,
      });
    });
  }

  const items = extractInvoiceItemsFromLines(
    lines,
    invoiceMonthIndex,
    invoiceYear,
    "pdf"
  );

  return {
    items,
    pages: pdf.numPages,
    lines: lines.length,
  };
}
