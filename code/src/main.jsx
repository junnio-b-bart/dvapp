import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import {
  Bell,
  CalendarDays,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Clock3,
  CloudUpload,
  CreditCard,
  Download,
  Eye,
  EyeOff,
  FileText,
  Filter,
  History,
  Info,
  List,
  Lock,
  LogOut,
  Menu,
  Pencil,
  Plus,
  PlusCircle,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  UserRound,
  WalletCards,
  X,
} from 'lucide-react';
import { parseInvoiceImageFiles, parseInvoicePdfImagesWithOcr } from './utils/invoiceImageParser.js';
import { parseInvoicePdfFile } from './utils/invoicePdfParser.js';
import * as db from './lib/db.js';
import './styles.css';

const banks = [
  ['itau', 'Itaú'],
  ['bb', 'Banco do Brasil'],
  ['caixa', 'Caixa Econômica Federal'],
  ['bradesco', 'Bradesco'],
  ['santander', 'Santander Brasil'],
  ['nubank', 'Nubank'],
  ['mercado-pago', 'Mercado Pago'],
  ['inter', 'Banco Inter'],
];

// Dado um valor armazenado ("DD/MM/AAAA", "DD/MM" ou apenas "DD"), retorna a
// próxima ocorrência daquele dia a partir de hoje no formato DD/MM/AAAA.
// Se hoje já passou do dia (ou é o próprio dia), avança para o mês seguinte.
// Isso mantém closeDate / dueDate sempre no próximo vencimento real.
function rollingCardDate(stored) {
  if (!stored) return '';
  const day = parseInt(String(stored).split('/')[0]) || 0;
  if (!day || day > 31) return stored; // valor inválido → devolve sem alterar
  const now = new Date();
  let month = now.getMonth() + 1; // 1-based
  let year  = now.getFullYear();
  if (now.getDate() >= day) {     // dia já ocorreu este mês → próximo mês
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

// Normaliza um card do formato Supabase (snake_case) para o formato do app (camelCase)
function normalizeCard(card) {
  return {
    id: card.id,
    name: card.name,
    last4: card.last4,
    owner: card.owner || '',
    bank: card.bank || 'nubank',
    brand: card.brand || 'mastercard',
    closeDate: rollingCardDate(card.close_date || card.closeDate || ''),
    dueDate:   rollingCardDate(card.due_date   || card.dueDate   || ''),
    position: card.position || 0,
  };
}

function getCurrentMonthYear() {
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
}

// Retorna o mês/ano da FATURA ABERTA considerando o dia de fechamento do cartão.
// Se hoje >= closingDay, o cartão já fechou → novas compras vão para o próximo mês.
function getInvoiceMonthYear(closingDay = 1) {
  const now = new Date();
  const today = now.getDate();
  let month = now.getMonth() + 1;
  let year = now.getFullYear();
  if (closingDay > 0 && today >= closingDay) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return { month, year, monthIndex: month - 1 };
}

// Retorna o mês/ano da FATURA de uma compra com base na sua data e no dia de fechamento.
// Regra: se o dia da compra >= dia de fechamento → cai na fatura do mês seguinte.
// Ex.: compra 03/05, fechamento 16 → fatura de maio (3 < 16).
//      compra 20/05, fechamento 16 → fatura de junho (20 >= 16).
// Se a data for inválida, cai na fatura atual (mesmo comportamento anterior).
function getInvoiceMonthYearForDate(dateStr, closingDay = 1) {
  const str = String(dateStr || '');
  let parts;
  if (str.includes('/')) {
    parts = str.split('/').map(Number); // DD/MM/YYYY
  } else if (str.includes('-')) {
    const iso = str.split('-').map(Number); // YYYY-MM-DD
    parts = [iso[2], iso[1], iso[0]]; // reordena para [day, month, year]
  } else {
    parts = [];
  }
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n) || n === 0)) {
    return getInvoiceMonthYear(closingDay); // fallback: fatura corrente
  }
  const [day, month, year] = parts;
  let invMonth = month;
  let invYear  = year;
  if (day >= closingDay) {
    invMonth += 1;
    if (invMonth > 12) { invMonth = 1; invYear += 1; }
  }
  return { month: invMonth, year: invYear };
}

// Extrai o dia de fechamento numérico de um cartão (closeDate pode ser "15/05/2026" ou "15")
function getCardClosingDay(card) {
  return parseInt(String(card?.closeDate || card?.close_date || '1').split('/')[0]) || 1;
}

function item(id, date, description, installment, amount, mine, manual = false) {
  return { id, date, description, installment, amount, mine, manual };
}

function inferBank(card) {
  const name = `${card.name || ''} ${card.id || ''}`.toLowerCase();
  if (name.includes('itau') || name.includes('itaú')) return 'itau';
  if (name.includes('bradesco')) return 'bradesco';
  if (name.includes('santander')) return 'santander';
  if (name.includes('mercado')) return 'mercado-pago';
  if (name.includes('inter')) return 'inter';
  if (name.includes('caixa')) return 'caixa';
  if (name.includes('brasil')) return 'bb';
  return 'nubank';
}

function getBankName(bankId) {
  return banks.find(([id]) => id === bankId)?.[1] || 'Nubank';
}

function getReferenceDateParts(closingDay = 0) {
  const { monthIndex, year } = getInvoiceMonthYear(closingDay);
  return { monthIndex, year };
}

// Detecta o mês/ano da fatura com base nas datas dos itens parseados.
// Para cada item, calcula a qual fatura pertenceria via getInvoiceMonthYearForDate,
// e retorna o mês/ano mais frequente. Isso permite identificar automaticamente
// se um PDF é de uma fatura passada (ex.: maio) mesmo que o período atual seja junho.
function detectInvoiceMonth(items, closingDay) {
  const counts = {};
  for (const item of items) {
    if (!item.date) continue;
    const { month, year } = getInvoiceMonthYearForDate(item.date, closingDay);
    const key = `${year}-${String(month).padStart(2, '0')}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return getInvoiceMonthYear(closingDay); // fallback: período atual
  const [yearStr, monthStr] = entries[0][0].split('-');
  return { month: Number(monthStr), year: Number(yearStr) };
}

function getReferenceMonthLabel(closingDay = 0) {
  const { monthIndex, year } = getReferenceDateParts(closingDay);
  const month = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'][monthIndex];
  return `${month}/${year}`;
}

// FIX: Usa métodos UTC para evitar deslocamento de data no fuso UTC-3 (Brasil)
function formatParserDate(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

// FIX: Retorna a data de hoje no formato DD/MM/AAAA
function getTodayFormatted() {
  const now = new Date();
  return `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
}

// FIX: Extrai iniciais do nome (máximo 2 letras)
function getInitials(name) {
  return String(name || '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'DC';
}

function normalizeParsedInvoiceItem(parsed, index) {
  const current = Math.max(1, Number(parsed.installmentNumber || 1));
  const total = Math.max(current, Number(parsed.totalInstallments || 1));
  return {
    id: parsed.key || `parsed-${Date.now()}-${index}`,
    date: formatParserDate(parsed.purchaseDateIso),
    description: String(parsed.description || 'LANCAMENTO SEM DESCRICAO').toUpperCase(),
    installment: total > 1 ? `${current}/${total}` : '-',
    amount: Number(parsed.installmentAmount || 0),
    mine: false,
    manual: false,
  };
}

function sortInvoiceItems(items) {
  return [...items].sort((a, b) => {
    const [dayA, monthA, yearA] = String(a.date || '').split('/').map(Number);
    const [dayB, monthB, yearB] = String(b.date || '').split('/').map(Number);
    return new Date(yearA || 0, (monthA || 1) - 1, dayA || 1) - new Date(yearB || 0, (monthB || 1) - 1, dayB || 1);
  });
}

function getForecastItems(items, monthDiff) {
  if (monthDiff <= 0) return [];
  return items.flatMap((item) => {
    if (!item.installment || item.installment === '-') return [];
    const parts = item.installment.split('/');
    if (parts.length !== 2) return [];
    const current = parseInt(parts[0], 10);
    const total = parseInt(parts[1], 10);
    if (Number.isNaN(current) || Number.isNaN(total) || current >= total) return [];
    const future = current + monthDiff;
    if (future > total) return [];
    return [{ ...item, id: `forecast-${item.id}-m${monthDiff}`, installment: `${future}/${total}` }];
  });
}

// Projeta parcelas de QUALQUER fatura para um mês/ano alvo.
// allMineItems: todos os itens "meus" com parcelas de TODAS as faturas do cartão.
// Calcula o offset entre o mês da fatura original do item e o mês alvo,
// e retorna a parcela correspondente se ainda estiver dentro do total.
function getForecastItemsForMonth(allMineItems, targetMonth, targetYear, closingDay) {
  return allMineItems.flatMap((item) => {
    if (!item.installment || item.installment === '-') return [];
    const parts = item.installment.split('/');
    if (parts.length !== 2) return [];
    const current = parseInt(parts[0], 10);
    const total = parseInt(parts[1], 10);
    if (Number.isNaN(current) || Number.isNaN(total) || current >= total) return [];
    const { month: invMonth, year: invYear } = getInvoiceMonthYearForDate(item.date, closingDay);
    const offset = (targetYear - invYear) * 12 + (targetMonth - invMonth);
    if (offset <= 0) return [];
    const futureInstallment = current + offset;
    if (futureInstallment > total) return [];
    return [{ ...item, id: `forecast-${item.id}-${targetMonth}-${targetYear}`, installment: `${futureInstallment}/${total}` }];
  });
}

function money(value) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function amountOnly(value) {
  return money(value).replace('R$', '').trim();
}

function App({ session }) {
  const userId = session.user.id;
  const [appLoading, setAppLoading] = useState(true);
  const [state, setState] = useState({
    activeTab: 'carteira',
    selectedCardId: null,
    drawerOpen: false,
    search: '',
    notificationBadge: 0,
    cards: [],
    itemsByCard: {},
    invoiceIdByCard: {},
    invoicesListByCard: {},  // { [cardId]: Invoice[] } — lista de todas as faturas do cartão
    allInstallmentItemsByCard: {},  // { [cardId]: Item[] } — itens meus c/ parcelas de TODAS as faturas
    notifications: { closing: true, due: true, forecast: true, upload: true, overdue: true },
    profileName: '',   // nome do usuário no app (profiles.name)
    theme: localStorage.getItem('app-theme') || 'ocean',
  });
  const [modal, setModal] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadProgress, setUploadProgress] = useState('');
  const [historyEdit, setHistoryEdit] = useState(null);  // { invoiceId, items, month, year, loading }
  const [historyModal, setHistoryModal] = useState(null);

  const selectedCard = state.cards.find((c) => c.id === state.selectedCardId) || state.cards[0];
  const currentItems = state.itemsByCard[selectedCard?.id] || [];

  // Parcelas de faturas PASSADAS que recaem no período de faturamento atual e são "minha".
  // Garante que a Carteira e Faturas mostrem continuidade de parcelados mesmo quando
  // a compra original está registrada em uma fatura de mês anterior.
  const projectedMineItems = useMemo(() => {
    const closingDay = getCardClosingDay(selectedCard);
    const { month, year } = getInvoiceMonthYear(closingDay);
    const allInstItems = state.allInstallmentItemsByCard[selectedCard?.id] || [];
    const projected = getForecastItemsForMonth(allInstItems, month, year, closingDay);
    return projected.filter(
      (proj) => proj.mine &&
        !currentItems.some(
          (real) => real.description === proj.description &&
            Math.abs(Number(real.amount) - Number(proj.amount)) < 0.01,
        ),
    );
  }, [selectedCard, state.allInstallmentItemsByCard, currentItems]);

  // Lista completa de itens exibíveis: reais + projeções de parcelas passadas
  const allDisplayItems = useMemo(
    () => [...currentItems, ...projectedMineItems],
    [currentItems, projectedMineItems],
  );

  const visibleItems = useMemo(
    () => allDisplayItems.filter((row) => row.description.toLowerCase().includes(state.search.toLowerCase())),
    [allDisplayItems, state.search],
  );

  const myItems = useMemo(
    () => allDisplayItems.filter((row) => row.mine),
    [allDisplayItems],
  );

  const totals = useMemo(() => ({
    all: allDisplayItems.reduce((sum, row) => sum + Number(row.amount), 0),
    mine: myItems.reduce((sum, row) => sum + Number(row.amount), 0),
    mineCount: myItems.length,
    allCount: allDisplayItems.length,
  }), [allDisplayItems, myItems]);

  // ── Carga inicial dos dados ───────────────────────────────────
  useEffect(() => {
    async function load() {
      const { data: cards } = await db.getCards(userId);
      if (!cards?.length) { setAppLoading(false); return; }

      const normalized = cards.map(normalizeCard);
      const firstId = normalized[0].id;

      // Mostra a fatura mais recente que já existe; se não houver nenhuma,
      // cria a do período de faturamento correto (considerando o fechamento).
      const { data: existingInvoices } = await db.getInvoicesByCard(firstId);
      let inv;
      if (existingInvoices?.length) {
        inv = existingInvoices[0]; // já ordenado por ano/mês desc
      } else {
        const { month, year } = getInvoiceMonthYear(getCardClosingDay(normalized[0]));
        const { data: created } = await db.getOrCreateInvoice(firstId, userId, month, year);
        inv = created;
      }
      const { data: items } = inv ? await db.getItemsByInvoice(inv.id) : { data: [] };
      const [{ data: notifs }, { data: profile }, { data: installItems }] = await Promise.all([
        db.getNotificationSettings(userId),
        db.getProfile(userId),
        db.getMineInstallmentItemsByCard(firstId),
      ]);

      setState((prev) => ({
        ...prev,
        cards: normalized,
        selectedCardId: firstId,
        itemsByCard: { [firstId]: items || [] },
        invoiceIdByCard: inv ? { [firstId]: inv.id } : {},
        invoicesListByCard: { [firstId]: existingInvoices || [] },
        allInstallmentItemsByCard: { [firstId]: installItems || [] },
        profileName: profile?.name || '',
        notifications: notifs
          ? { closing: notifs.closing, due: notifs.due, forecast: notifs.forecast, upload: notifs.upload, overdue: notifs.overdue }
          : prev.notifications,
      }));
      setAppLoading(false);
    }
    load();
  }, [userId]);

  function update(patch) {
    setState((prev) => ({ ...prev, ...patch }));
  }

  // Aplica o tema de cor no <html> e persiste
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('theme-orange', 'theme-amber', 'theme-purple');
    if (state.theme !== 'ocean') root.classList.add(`theme-${state.theme}`);
    localStorage.setItem('app-theme', state.theme);
  }, [state.theme]);

  function setTab(tab) {
    update({ activeTab: tab, drawerOpen: false });
  }

  async function selectCard(id) {
    update({ selectedCardId: id, drawerOpen: false, search: '' });
    // Lazy load: carrega os itens do cartão se ainda não foram carregados
    if (state.itemsByCard[id] === undefined) {
      const card = state.cards.find((c) => c.id === id);
      // Mostra a fatura mais recente existente; se não houver, cria a do período correto
      const { data: existingInvoices } = await db.getInvoicesByCard(id);
      let inv;
      if (existingInvoices?.length) {
        inv = existingInvoices[0];
      } else {
        const { month, year } = getInvoiceMonthYear(getCardClosingDay(card));
        const { data: created } = await db.getOrCreateInvoice(id, userId, month, year);
        inv = created;
      }
      const [{ data: items }, { data: installItems }] = await Promise.all([
        inv ? db.getItemsByInvoice(inv.id) : { data: [] },
        db.getMineInstallmentItemsByCard(id),
      ]);
      setState((prev) => ({
        ...prev,
        itemsByCard: { ...prev.itemsByCard, [id]: items || [] },
        invoiceIdByCard: { ...prev.invoiceIdByCard, ...(inv ? { [id]: inv.id } : {}) },
        invoicesListByCard: { ...prev.invoicesListByCard, [id]: existingInvoices || [] },
        allInstallmentItemsByCard: { ...prev.allInstallmentItemsByCard, [id]: installItems || [] },
      }));
    }
  }

  function updateCardItems(items) {
    setState((prev) => ({ ...prev, itemsByCard: { ...prev.itemsByCard, [selectedCard.id]: items } }));
  }

  // Recarrega itens meus c/ parcelas do cartão — atualiza projeção de meses futuros no Histórico
  async function reloadInstallmentItems(cardId) {
    const { data } = await db.getMineInstallmentItemsByCard(cardId);
    if (data) {
      setState((prev) => ({
        ...prev,
        allInstallmentItemsByCard: { ...prev.allInstallmentItemsByCard, [cardId]: data },
      }));
    }
  }

  async function toggleMine(id) {
    const row = currentItems.find((r) => r.id === id);
    if (!row) return;
    const next = !row.mine;
    updateCardItems(currentItems.map((r) => r.id === id ? { ...r, mine: next } : r));
    await db.updateItem(id, userId, { mine: next });
    reloadInstallmentItems(selectedCard.id);
  }

  async function upsertItem(next) {
    const normalized = {
      ...next,
      amount: Number(String(next.amount).replace(/[^\d,.-]/g, '').replace(',', '.')) || 0,
      installment: next.installment || '-',
    };
    const exists = currentItems.some((row) => row.id === normalized.id);
    if (exists) {
      updateCardItems(currentItems.map((row) => row.id === normalized.id ? normalized : row));
      await db.updateItem(normalized.id, userId, normalized);
    } else {
      // Rota para a fatura correta com base na DATA DA COMPRA e no dia de fechamento.
      // Ex.: compra 03/05 com fechamento dia 16 → fatura de maio, não de junho.
      const { month, year } = getInvoiceMonthYearForDate(normalized.date, getCardClosingDay(selectedCard));
      const { data: inv } = await db.getOrCreateInvoice(selectedCard.id, userId, month, year);
      const invoiceId = inv?.id;
      const displayedInvoiceId = state.invoiceIdByCard[selectedCard.id];
      if (invoiceId) {
        const { data: saved } = await db.insertItem(invoiceId, selectedCard.id, userId, normalized);
        const withId = saved ? { ...normalized, id: saved.id } : { ...normalized, id: `m-${Date.now()}` };
        if (invoiceId !== displayedInvoiceId) {
          // Novo item foi para uma fatura diferente da exibida → recarrega tudo e troca o display
          const [{ data: allItems }, { data: newInvoicesList }] = await Promise.all([
            db.getItemsByInvoice(invoiceId),
            db.getInvoicesByCard(selectedCard.id),
          ]);
          setState((prev) => ({
            ...prev,
            itemsByCard: { ...prev.itemsByCard, [selectedCard.id]: sortInvoiceItems(allItems || [withId]) },
            invoiceIdByCard: { ...prev.invoiceIdByCard, [selectedCard.id]: invoiceId },
            invoicesListByCard: { ...prev.invoicesListByCard, [selectedCard.id]: newInvoicesList || [] },
          }));
        } else {
          updateCardItems([withId, ...currentItems]);
        }
      } else {
        updateCardItems([normalized, ...currentItems]);
      }
    }
    reloadInstallmentItems(selectedCard.id);
    setModal(null);
  }

  async function removeItem(id) {
    updateCardItems(currentItems.filter((row) => row.id !== id));
    await db.deleteItem(id, userId);
    reloadInstallmentItems(selectedCard.id);
    setModal(null);
  }

  async function bulkDeleteItems(ids, onDone) {
    if (!ids.length) return;
    updateCardItems(currentItems.filter((row) => !ids.includes(row.id)));
    await Promise.all(ids.map((id) => db.deleteItem(id, userId)));
    reloadInstallmentItems(selectedCard.id);
    onDone?.();
  }

  async function addCard(card) {
    const { data: saved } = await db.insertCard(userId, card);
    const nextCard = saved ? normalizeCard(saved) : { ...card, id: `card-${Date.now()}`, brand: card.brand || 'mastercard' };
    setState((prev) => ({
      ...prev,
      cards: [...prev.cards, nextCard],
      itemsByCard: { ...prev.itemsByCard, [nextCard.id]: [] },
      selectedCardId: nextCard.id,
      drawerOpen: false,
    }));
    setModal(null);
  }

  async function updateCard(card) {
    setState((prev) => ({ ...prev, cards: prev.cards.map((c) => c.id === card.id ? card : c) }));
    await db.updateCard(card.id, userId, card);
  }

  async function deleteCard() {
    const id = selectedCard.id;
    const remaining = state.cards.filter((c) => c.id !== id);
    const { [id]: _deleted, ...nextItems } = state.itemsByCard;
    setState((prev) => ({
      ...prev,
      cards: remaining,
      itemsByCard: nextItems,
      selectedCardId: remaining[0]?.id || null,
    }));
    await db.deleteCard(id, userId);
    setModal(null);
  }

  async function processUpload(files, mode = 'replace') {
    if (!files.length) { setUploadError('Selecione um PDF ou imagens da fatura.'); return; }
    setUploading(true); setUploadError(''); setUploadProgress('Preparando arquivos...');
    try {
      const pdfFiles = files.filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
      const imageFiles = files.filter((file) => String(file.type || '').startsWith('image/'));
      const { monthIndex, year } = getReferenceDateParts(getCardClosingDay(selectedCard));
      const parsedGroups = [];

      for (const file of pdfFiles) {
        setUploadProgress(`Lendo PDF: ${file.name}`);
        const parsedPdf = await parseInvoicePdfFile(file, monthIndex, year);
        if (parsedPdf.items?.length) {
          parsedGroups.push(parsedPdf);
        } else {
          setUploadProgress(`PDF sem texto encontrado. Tentando OCR: ${file.name}`);
          parsedGroups.push(await parseInvoicePdfImagesWithOcr(file, monthIndex, year, (progress) => {
            setUploadProgress(`Lendo PDF com OCR... ${Math.round(progress * 100)}%`);
          }));
        }
      }
      if (imageFiles.length) {
        setUploadProgress('Lendo imagens com OCR...');
        parsedGroups.push(await parseInvoiceImageFiles(imageFiles, monthIndex, year, (progress) => {
          setUploadProgress(`Lendo imagens com OCR... ${Math.round(progress * 100)}%`);
        }));
      }

      const parsedItems = parsedGroups.flatMap((group) => group.items || []);
      const nextItems = sortInvoiceItems(parsedItems.map(normalizeParsedInvoiceItem).filter((row) => row.date && row.description && row.amount > 0));
      if (!nextItems.length) throw new Error('Não encontrei lançamentos nessa fatura. Tente um PDF com texto selecionável ou fotos mais nítidas e bem iluminadas.');

      // Salva no Supabase
      setUploadProgress('Salvando no servidor...');
      const closingDay = getCardClosingDay(selectedCard);
      const currentBilling = getInvoiceMonthYear(closingDay);

      // Auto-detecta o mês/ano da fatura pelas datas dos itens parseados.
      // Isso evita que um PDF de maio seja salvo na fatura de junho quando
      // o período atual já é junho (dia de fechamento já passou).
      const { month, year: yr } = detectInvoiceMonth(nextItems, closingDay);
      const isCurrentPeriod = month === currentBilling.month && yr === currentBilling.year;

      // Abre ou cria a fatura do mês detectado
      let invoiceId = isCurrentPeriod ? state.invoiceIdByCard[selectedCard.id] : null;
      if (!invoiceId) {
        const { data: inv } = await db.getOrCreateInvoice(selectedCard.id, userId, month, yr);
        invoiceId = inv?.id;
      }
      if (invoiceId) {
        if (mode === 'append') {
          // Adiciona sem apagar nada — apenas insere os novos itens do PDF
          const rows = nextItems.map((item) => ({
            invoice_id: invoiceId,
            card_id: selectedCard.id,
            user_id: userId,
            date: item.date,
            description: item.description,
            installment: item.installment || '-',
            amount: Number(item.amount) || 0,
            mine: Boolean(item.mine),
            manual: false,
          }));
          await db.insertItems(rows);
        } else {
          // Substitui itens importados anteriormente (preserva manuais)
          await db.replaceInvoiceItems(invoiceId, selectedCard.id, userId, nextItems);
        }
        for (const file of files) await db.uploadInvoiceFile(userId, selectedCard.id, file);
      }

      // Recarrega todos os itens do banco para garantir consistência
      let allItems = nextItems;
      if (invoiceId) {
        const { data: dbItems } = await db.getItemsByInvoice(invoiceId);
        if (dbItems?.length) allItems = sortInvoiceItems(dbItems);
      }

      if (isCurrentPeriod) {
        // Fatura atual → exibe na aba Faturas como antes
        setState((prev) => ({
          ...prev,
          activeTab: 'faturas',
          itemsByCard: { ...prev.itemsByCard, [selectedCard.id]: allItems },
          invoiceIdByCard: { ...prev.invoiceIdByCard, ...(invoiceId ? { [selectedCard.id]: invoiceId } : {}) },
        }));
      } else {
        // Fatura PASSADA → recarrega a lista de faturas e abre o Histórico
        // (não altera itemsByCard para não contaminar a fatura atual do cartão)
        const { data: invoicesList } = await db.getInvoicesByCard(selectedCard.id);
        setState((prev) => ({
          ...prev,
          activeTab: 'historico',
          invoicesListByCard: { ...prev.invoicesListByCard, [selectedCard.id]: invoicesList || [] },
        }));
      }
      reloadInstallmentItems(selectedCard.id);
      setModal(null);
    } catch (error) {
      setUploadError(error.message);
    } finally {
      setUploading(false); setUploadProgress('');
    }
  }

  async function saveNotifications(notifications) {
    update({ notifications, notificationBadge: 1 });
    await db.upsertNotificationSettings(userId, notifications);
    setModal(null);
  }

  async function closeInvoice() {
    const invoiceId = state.invoiceIdByCard[selectedCard?.id];
    if (invoiceId) await db.closeInvoice(invoiceId, userId);
    setModal(null);
  }

  // Carrega os itens "meus" de um mês/ano específico do banco — usado pelo Histórico
  async function loadHistoryMonth(month, year) {
    if (!selectedCard) return [];
    const { data: inv } = await db.getInvoiceByMonthYear(selectedCard.id, month, year);
    if (!inv) return [];
    const { data: items } = await db.getItemsByInvoice(inv.id);
    return (items || []).filter((r) => r.mine);
  }

  // ── Edição de fatura histórica ──────────────────────────────────
  // Abre o editor de fatura para o mês/ano passado.
  // Para o período de faturamento atual, redireciona para a aba Faturas.
  async function openHistoryInvoice(month, year) {
    if (!selectedCard) return;
    const { month: billingMonth, year: billingYear } = getInvoiceMonthYear(getCardClosingDay(selectedCard));
    if (month === billingMonth && year === billingYear) {
      setTab('faturas');
      return;
    }
    // Mostra loading imediato e carrega a fatura do banco
    setHistoryEdit({ invoiceId: null, items: [], month, year, loading: true });
    const { data: inv } = await db.getInvoiceByMonthYear(selectedCard.id, month, year);
    let invoiceId;
    if (inv) {
      invoiceId = inv.id;
    } else {
      // Cria a fatura para o mês se ainda não existia (permite adicionar itens históricos)
      const { data: created } = await db.getOrCreateInvoice(selectedCard.id, userId, month, year);
      invoiceId = created?.id;
      if (invoiceId) {
        // Atualiza a lista de faturas do cartão com a nova fatura criada
        const { data: newList } = await db.getInvoicesByCard(selectedCard.id);
        setState((prev) => ({
          ...prev,
          invoicesListByCard: { ...prev.invoicesListByCard, [selectedCard.id]: newList || [] },
        }));
      }
    }
    if (!invoiceId) { setHistoryEdit(null); return; }
    const { data: items } = await db.getItemsByInvoice(invoiceId);
    setHistoryEdit({ invoiceId, items: sortInvoiceItems(items || []), month, year, loading: false });
  }

  function closeHistoryEdit() {
    setHistoryEdit(null);
    setHistoryModal(null);
  }

  async function historyToggleMine(id) {
    if (!historyEdit) return;
    const row = historyEdit.items.find((r) => r.id === id);
    if (!row) return;
    const next = !row.mine;
    setHistoryEdit((prev) => ({ ...prev, items: prev.items.map((r) => r.id === id ? { ...r, mine: next } : r) }));
    await db.updateItem(id, userId, { mine: next });
    reloadInstallmentItems(selectedCard.id);
  }

  async function historyUpsertItem(next) {
    if (!historyEdit) return;
    const normalized = {
      ...next,
      amount: Number(String(next.amount).replace(/[^\d,.-]/g, '').replace(',', '.')) || 0,
      installment: next.installment || '-',
    };
    const exists = historyEdit.items.some((row) => row.id === normalized.id);
    if (exists) {
      setHistoryEdit((prev) => ({ ...prev, items: prev.items.map((r) => r.id === normalized.id ? normalized : r) }));
      await db.updateItem(normalized.id, userId, normalized);
    } else {
      const { data: saved } = await db.insertItem(historyEdit.invoiceId, selectedCard.id, userId, normalized);
      const withId = saved ? { ...normalized, id: saved.id } : { ...normalized, id: `m-${Date.now()}` };
      setHistoryEdit((prev) => ({ ...prev, items: sortInvoiceItems([withId, ...prev.items]) }));
    }
    reloadInstallmentItems(selectedCard.id);
    setHistoryModal(null);
  }

  async function historyRemoveItem(id) {
    if (!historyEdit) return;
    setHistoryEdit((prev) => ({ ...prev, items: prev.items.filter((r) => r.id !== id) }));
    await db.deleteItem(id, userId);
    reloadInstallmentItems(selectedCard.id);
    setHistoryModal(null);
  }

  async function historyBulkDeleteItems(ids, onDone) {
    if (!ids.length || !historyEdit) return;
    setHistoryEdit((prev) => ({ ...prev, items: prev.items.filter((r) => !ids.includes(r.id)) }));
    await Promise.all(ids.map((id) => db.deleteItem(id, userId)));
    reloadInstallmentItems(selectedCard.id);
    onDone?.();
  }

  // Sobe um PDF/imagem para a fatura de um mês passado (roda o mesmo parser, mas
  // usa o mês/ano histórico como contexto e grava na fatura já aberta no historyEdit).
  async function processHistoryUpload(files, mode = 'replace') {
    if (!files.length || !historyEdit) { setUploadError('Selecione um PDF ou imagens da fatura.'); return; }
    setUploading(true); setUploadError(''); setUploadProgress('Preparando arquivos...');
    try {
      const pdfFiles = files.filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
      const imageFiles = files.filter((f) => String(f.type || '').startsWith('image/'));
      const monthIndex = historyEdit.month - 1;
      const year = historyEdit.year;
      const parsedGroups = [];

      for (const file of pdfFiles) {
        setUploadProgress(`Lendo PDF: ${file.name}`);
        const parsedPdf = await parseInvoicePdfFile(file, monthIndex, year);
        if (parsedPdf.items?.length) {
          parsedGroups.push(parsedPdf);
        } else {
          setUploadProgress(`PDF sem texto. Tentando OCR: ${file.name}`);
          parsedGroups.push(await parseInvoicePdfImagesWithOcr(file, monthIndex, year, (p) => {
            setUploadProgress(`Lendo PDF com OCR... ${Math.round(p * 100)}%`);
          }));
        }
      }
      if (imageFiles.length) {
        setUploadProgress('Lendo imagens com OCR...');
        parsedGroups.push(await parseInvoiceImageFiles(imageFiles, monthIndex, year, (p) => {
          setUploadProgress(`Lendo imagens com OCR... ${Math.round(p * 100)}%`);
        }));
      }

      const parsedItems = parsedGroups.flatMap((g) => g.items || []);
      const nextItems = sortInvoiceItems(parsedItems.map(normalizeParsedInvoiceItem).filter((r) => r.date && r.description && r.amount > 0));
      if (!nextItems.length) throw new Error('Não encontrei lançamentos. Tente um PDF com texto selecionável ou fotos mais nítidas e bem iluminadas.');

      setUploadProgress('Salvando no servidor...');
      const invoiceId = historyEdit.invoiceId;
      if (invoiceId) {
        if (mode === 'append') {
          const rows = nextItems.map((it) => ({
            invoice_id: invoiceId, card_id: selectedCard.id, user_id: userId,
            date: it.date, description: it.description,
            installment: it.installment || '-', amount: Number(it.amount) || 0,
            mine: Boolean(it.mine), manual: false,
          }));
          await db.insertItems(rows);
        } else {
          await db.replaceInvoiceItems(invoiceId, selectedCard.id, userId, nextItems);
        }
        for (const file of files) await db.uploadInvoiceFile(userId, selectedCard.id, file);
        // Recarrega todos os itens da fatura histórica após o upload
        const { data: dbItems } = await db.getItemsByInvoice(invoiceId);
        if (dbItems?.length) setHistoryEdit((prev) => ({ ...prev, items: sortInvoiceItems(dbItems) }));
      }
      reloadInstallmentItems(selectedCard.id);
      setHistoryModal(null);
    } catch (error) {
      setUploadError(error.message);
    } finally {
      setUploading(false); setUploadProgress('');
    }
  }

  if (appLoading) return <LoadingScreen />;

  // Avatar usa o nome do perfil; fallback para o titular do cartão selecionado
  const ownerInitials = getInitials(state.profileName) || getInitials(selectedCard?.owner);

  return (
    <div className="app-shell">
      <Topbar
        activeTab={state.activeTab}
        badge={state.notificationBadge}
        ownerInitials={ownerInitials}
        profileName={state.profileName}
        session={session}
        onTab={setTab}
        onMenu={() => update({ drawerOpen: true })}
        onNotifSettings={() => { setTab('ajustes'); update({ focusNotif: (state.focusNotif || 0) + 1 }); }}
        onSignOut={db.signOut}
        onEditAccount={() => setModal('edit-account')}
      />
      <div className="layout">
        <Sidebar
          cards={state.cards}
          current={selectedCard}
          open={state.drawerOpen}
          onClose={() => update({ drawerOpen: false })}
          onSelect={selectCard}
          onAdd={() => setModal('add-card')}
        />
        <main className="workspace">
          {!selectedCard ? (
            <div className="no-cards-screen">
              <WalletCards size={56} />
              <h2>Nenhum cartão cadastrado</h2>
              <p>Adicione seu primeiro cartão para começar a usar o DivideConta.</p>
              <button className="primary" type="button" onClick={() => setModal('add-card')}>
                <Plus size={19} />Adicionar cartão
              </button>
            </div>
          ) : (
            <>
              {state.activeTab === 'carteira' && (
                <WalletPage
                  card={selectedCard}
                  items={myItems}
                  totals={totals}
                  onView={() => setTab('faturas')}
                  onCloseInvoice={() => setModal('close-invoice')}
                />
              )}
              {state.activeTab === 'faturas' && (
                <InvoicesPage
                  key={selectedCard?.id}
                  items={visibleItems}
                  totals={totals}
                  search={state.search}
                  onSearch={(search) => update({ search })}
                  onToggle={toggleMine}
                  onUpload={() => setModal('upload')}
                  onAdd={() => setModal('add-item')}
                  onEdit={(row) => setModal({ type: 'edit-item', row })}
                  onSave={() => setTab('carteira')}
                  onBulkDelete={bulkDeleteItems}
                />
              )}
              {state.activeTab === 'historico' && !historyEdit && (
                <HistoryPage
                  key={selectedCard?.id}
                  items={myItems}
                  totals={totals}
                  invoices={state.invoicesListByCard[selectedCard?.id] || []}
                  closingDay={getCardClosingDay(selectedCard)}
                  onLoadMonthItems={loadHistoryMonth}
                  onOpenInvoice={openHistoryInvoice}
                  onUpload={() => setModal('upload')}
                  allInstallmentItems={state.allInstallmentItemsByCard[selectedCard?.id] || []}
                />
              )}
              {state.activeTab === 'historico' && historyEdit && (
                <HistoryEditPage
                  edit={historyEdit}
                  card={selectedCard}
                  onBack={closeHistoryEdit}
                  onToggle={historyToggleMine}
                  onAdd={() => setHistoryModal('add-item')}
                  onEdit={(row) => setHistoryModal({ type: 'edit-item', row })}
                  onUpload={() => { setUploadError(''); setHistoryModal('upload'); }}
                  onBulkDelete={historyBulkDeleteItems}
                />
              )}
              {state.activeTab === 'ajustes' && (
                <SettingsPage
                  session={session}
                  card={selectedCard}
                  profileName={state.profileName}
                  notifications={state.notifications}
                  theme={state.theme}
                  onTheme={(theme) => update({ theme })}
                  onSignOut={db.signOut}
                  onChangeCard={updateCard}
                  onSaveProfile={async (name) => {
                    update({ profileName: name });
                    await db.updateProfile(userId, { name });
                  }}
                  onNotifications={(notifications) => update({ notifications })}
                  onSaveNotifications={(notifications) => db.upsertNotificationSettings(userId, notifications)}
                  onDelete={() => setModal('delete-card')}
                  onEditAccount={() => setModal('edit-account')}
                  focusNotif={state.focusNotif || 0}
                />
              )}
            </>
          )}
        </main>
      </div>
      <BottomNav activeTab={state.activeTab} onTab={setTab} />

      {modal === 'add-card' && <CardModal onClose={() => setModal(null)} onSave={addCard} />}
      {modal === 'add-item' && <ItemModal title="Adicionar item manual" card={selectedCard} onClose={() => setModal(null)} onSave={upsertItem} />}
      {modal?.type === 'edit-item' && <ItemModal title="Editar item" card={selectedCard} row={modal.row} onClose={() => setModal(null)} onSave={upsertItem} onDelete={removeItem} />}
      {modal === 'upload' && <UploadModal card={selectedCard} uploading={uploading} progress={uploadProgress} error={uploadError} onClose={() => setModal(null)} onUpload={processUpload} />}
      {modal === 'close-invoice' && <CloseInvoiceModal card={selectedCard} onClose={() => setModal(null)} onConfirm={closeInvoice} />}
      {modal === 'delete-card' && <DeleteCardModal card={selectedCard} onClose={() => setModal(null)} onDelete={deleteCard} />}
      {modal === 'notifications' && <NotificationsModal values={state.notifications} onClose={() => setModal(null)} onSave={saveNotifications} />}
      {modal === 'edit-account' && (
        <EditAccountModal
          session={session}
          profileName={state.profileName}
          onClose={() => setModal(null)}
          onSaveProfile={async (name) => {
            update({ profileName: name });
            await db.updateProfile(userId, { name });
          }}
        />
      )}

      {/* ── Modais do editor de fatura histórica ── */}
      {historyModal === 'add-item' && (
        <ItemModal title="Adicionar item manual" card={selectedCard} onClose={() => setHistoryModal(null)} onSave={historyUpsertItem} />
      )}
      {historyModal?.type === 'edit-item' && (
        <ItemModal title="Editar item" card={selectedCard} row={historyModal.row} onClose={() => setHistoryModal(null)} onSave={historyUpsertItem} onDelete={historyRemoveItem} />
      )}
      {historyModal === 'upload' && historyEdit && (
        <UploadModal
          card={selectedCard}
          uploading={uploading}
          progress={uploadProgress}
          error={uploadError}
          referenceDateLabel={`${['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'][historyEdit.month - 1]} / ${historyEdit.year}`}
          onClose={() => { setHistoryModal(null); setUploadError(''); }}
          onUpload={processHistoryUpload}
        />
      )}
    </div>
  );
}

/* Mini-dropdown da conta (portal, posicionado abaixo do avatar) */
function AccountDropdown({ initials, profileName, email, onEditAccount, onSignOut, triggerRef, onClose }) {
  const popRef = useRef(null);
  const [style, setStyle] = useState({});

  useEffect(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const W = 230;
    const left = Math.max(8, Math.min(rect.right - W, window.innerWidth - W - 8));
    setStyle({ top: rect.bottom + 6, left, width: W });
  }, []);

  useEffect(() => {
    function close(e) {
      if (popRef.current && !popRef.current.contains(e.target) && !triggerRef.current?.contains(e.target))
        onClose();
    }
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  return createPortal(
    <div className="acct-dropdown" ref={popRef} style={style}>
      <div className="acct-dd-header">
        <span className="account-avatar acct-dd-avatar">{initials}</span>
        <div className="account-info">
          <strong className="account-name">{profileName || 'Usuário'}</strong>
          <span className="account-email">{email}</span>
        </div>
      </div>
      <div className="acct-dd-actions">
        <button type="button" className="acct-dd-btn"
          onClick={() => { onClose(); onEditAccount(); }}>
          <Settings size={14} /> Editar conta
        </button>
        <button type="button" className="acct-dd-btn danger"
          onClick={() => { onClose(); onSignOut(); }}>
          <LogOut size={14} /> Sair
        </button>
      </div>
    </div>,
    document.body
  );
}

/* Balão de notificações (portal) */
function NotifDropdown({ badge, triggerRef, onClose, onSettings }) {
  const popRef = useRef(null);
  const [style, setStyle] = useState({});

  useEffect(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const W = 270;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - W - 8));
    setStyle({ top: rect.bottom + 8, left, width: W });
  }, []);

  useEffect(() => {
    function close(e) {
      if (popRef.current && !popRef.current.contains(e.target) && !triggerRef.current?.contains(e.target))
        onClose();
    }
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', close, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  return createPortal(
    <div className="notif-dropdown" ref={popRef} style={style}>
      <div className="notif-dd-head">
        <span>Notificações</span>
        <button type="button" className="notif-dd-gear" title="Ajustes de notificação"
          onClick={() => { onClose(); onSettings(); }}>
          <Settings size={15} />
        </button>
      </div>
      <div className="notif-dd-body">
        <Bell size={28} className="notif-dd-icon" />
        <p>Nenhuma notificação no momento.</p>
      </div>
    </div>,
    document.body
  );
}

function Topbar({ activeTab, badge, ownerInitials, profileName, session, onTab, onMenu, onNotifSettings, onSignOut, onEditAccount }) {
  const [ddOpen, setDdOpen]       = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const acctRef  = useRef(null);
  const bellRef  = useRef(null);
  const email = session?.user?.email || '';

  return (
    <header className="topbar">
      <button className="mobile-icon" type="button" onClick={onMenu} aria-label="Abrir menu"><Menu size={24} /></button>
      <Logo />
      <nav className="desktop-nav" aria-label="Navegação principal">
        <NavButton icon={WalletCards} label="Carteira" active={activeTab === 'carteira'} onClick={() => onTab('carteira')} />
        <NavButton icon={FileText} label="Faturas" active={activeTab === 'faturas'} onClick={() => onTab('faturas')} />
        <NavButton icon={History} label="Histórico" active={activeTab === 'historico'} onClick={() => onTab('historico')} />
        <NavButton icon={Settings} label="Ajustes" active={activeTab === 'ajustes'} onClick={() => onTab('ajustes')} />
      </nav>
      <div className="top-actions">
        <button className="bell-button" type="button" ref={bellRef}
          onClick={() => setNotifOpen((o) => !o)} aria-label="Notificações">
          <Bell size={24} />
          {badge > 0 && <span>{badge}</span>}
        </button>
        {notifOpen && (
          <NotifDropdown
            badge={badge}
            triggerRef={bellRef}
            onClose={() => setNotifOpen(false)}
            onSettings={() => { setNotifOpen(false); onNotifSettings(); }}
          />
        )}
        <button
          className="avatar-button"
          type="button"
          ref={acctRef}
          onClick={() => setDdOpen((o) => !o)}
          aria-label="Conta"
        >{ownerInitials}</button>
        <ChevronDown
          className="desktop-only acct-chevron"
          size={20}
          onClick={() => setDdOpen((o) => !o)}
        />
      </div>
      {ddOpen && (
        <AccountDropdown
          initials={ownerInitials}
          profileName={profileName}
          email={email}
          onEditAccount={onEditAccount}
          onSignOut={onSignOut}
          triggerRef={acctRef}
          onClose={() => setDdOpen(false)}
        />
      )}
    </header>
  );
}

const BASE = import.meta.env.BASE_URL;

function Logo() {
  return (
    <button className="logo" type="button" aria-label="DivideConta">
      <img src={`${BASE}logofull.png`} alt="DivideConta" className="logo-full-img" />
      <img src={`${BASE}logoicon.png`} alt="DivideConta" className="logo-icon-img" />
    </button>
  );
}

function LogoMark() {
  return (
    <svg className="logo-mark" viewBox="0 0 48 48" aria-hidden="true">
      <rect x="8" y="13" width="28" height="22" rx="5" fill="none" stroke="currentColor" strokeWidth="3.2" />
      <path d="M8 20h28" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
      <rect x="18" y="25" width="16" height="12" rx="3" fill="#061a33" stroke="currentColor" strokeWidth="3.2" />
      <circle cx="32" cy="31" r="1.8" fill="currentColor" />
    </svg>
  );
}

function NavButton({ icon: Icon, label, active, onClick }) {
  return (
    <button className={`nav-button ${active ? 'active' : ''}`} type="button" onClick={onClick}>
      <Icon size={21} />
      <span>{label}</span>
    </button>
  );
}

function Sidebar({ cards, current, open, onClose, onSelect, onAdd }) {
  return (
    <>
      <button className={`drawer-scrim ${open ? 'open' : ''}`} type="button" onClick={onClose} aria-label="Fechar menu" />
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-mobile-title">
          <Logo />
        </div>
        <div className="sidebar-heading">
          <span>MEUS CARTÕES</span>
        </div>
        <div className="card-list">
          {cards.map((card) => (
            <button className={`card-tile ${card.id === current?.id ? 'active' : ''}`} type="button" key={card.id} onClick={() => onSelect(card.id)}>
              <BankBadge bank={card.bank} />
              <span><strong>{card.name}</strong><small>•••• {card.last4}</small></span>
            </button>
          ))}
        </div>
        <button className="add-card" type="button" onClick={onAdd}><Plus size={25} />Adicionar cartão</button>
        <div className="security-box">
          <ShieldCheck size={20} />
          <p>Seus dados estão protegidos com acesso seguro no app.</p>
          <button type="button">Saiba mais</button>
        </div>
      </aside>
    </>
  );
}

function BankBadge({ bank }) {
  const bankId = bank || 'nubank';
  if (bankId === 'nubank') return <span className="bank-badge nubank">nu</span>;
  if (bankId === 'itau') return <span className="bank-badge itau">itaú</span>;
  if (bankId === 'bradesco') return <span className="bank-badge bradesco">♢</span>;
  if (bankId === 'bb') return <span className="bank-badge bb">BB</span>;
  if (bankId === 'caixa') return <span className="bank-badge caixa">CA</span>;
  if (bankId === 'santander') return <span className="bank-badge santander">S</span>;
  if (bankId === 'mercado-pago') return <span className="bank-badge mercado">MP</span>;
  if (bankId === 'inter') return <span className="bank-badge inter">in</span>;
  return <span className="bank-badge generic"><CreditCard size={22} /></span>;
}

// FIX: Usa o card prop para mostrar nome do cartão na carteira
function WalletPage({ card, items, totals, onView, onCloseInvoice }) {
  return (
    <div className="page-stack wallet-stack">
      <section className="metric-grid wallet-grid">
        <Metric icon={ReceiptIcon} title="Minha fatura" value={money(totals.mine)} />
        <Metric icon={List} title="Meus itens" value={`${totals.mineCount} itens`} />
      </section>
      <SectionTitle title="Minha fatura atual" />
      <CleanTable mode="wallet" items={items} />
      <SummaryBar
        action="Ver fatura"
        onAction={onView}
        secondaryAction="Encerrar fatura"
        onSecondary={onCloseInvoice}
      />
    </div>
  );
}

function InvoicesPage({ items, totals, search, onSearch, onToggle, onUpload, onAdd, onEdit, onSave, onBulkDelete }) {
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState(new Set());
  const [confirmDelete, setConfirmDelete] = useState(null); // null | string[]

  function toggleBulkSelect(id) {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleBulkToggleAll(ids, select) {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (select ? next.add(id) : next.delete(id)));
      return next;
    });
  }

  function exitBulk() { setBulkMode(false); setBulkSelected(new Set()); }

  return (
    <div className="page-stack invoices-stack">
      <section className="metric-grid wallet-grid">
        <Metric icon={FileText} title="Total da fatura" value={money(totals.all)} />
        <Metric icon={UserRound} title="Minha parte" value={money(totals.mine)} />
      </section>
      <div className="action-row no-upload">
        <button className="primary add-item-btn" type="button" onClick={onAdd}><Plus size={19} />Adicionar item</button>
        <button className="ghost small filters-btn" type="button"><Filter size={18} /><span className="filters-label">Filtros</span></button>
        <label className="search-field"><Search size={18} /><input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Buscar descrição" /></label>
      </div>

      {/* ── Linha de seção com controles de seleção em massa ── */}
      <div className="section-title-row">
        <SectionTitle title="Fatura completa" />
        {!bulkMode ? (
          <button className="ghost small bulk-select-trigger" type="button" onClick={() => setBulkMode(true)}>
            <CheckSquare size={16} />Selecionar
          </button>
        ) : (
          <div className="bulk-row-controls">
            <span className="bulk-count">{bulkSelected.size} selecionado{bulkSelected.size !== 1 ? 's' : ''}</span>
            <button className="ghost small" type="button" onClick={exitBulk}><X size={16} />Cancelar</button>
            {bulkSelected.size > 0 && (
              <button className="danger-button small" type="button" onClick={() => setConfirmDelete([...bulkSelected])}>
                <Trash2 size={16} />Excluir ({bulkSelected.size})
              </button>
            )}
          </div>
        )}
      </div>

      <CleanTable
        mode="invoice"
        items={items}
        onToggle={onToggle}
        onEdit={onEdit}
        bulkMode={bulkMode}
        bulkSelected={bulkSelected}
        onBulkToggle={toggleBulkSelect}
        onBulkToggleAll={handleBulkToggleAll}
      />
      {!bulkMode && (
        <SummaryBar
          icon={List}
          count={totals.mineCount}
          countSuffix={totals.allCount}
          label="itens selecionados"
          secondaryAction="Adicionar item"
          onSecondary={onAdd}
          action="Salvar alterações"
          onAction={onSave}
          uploadAction="Subir fatura"
          onUpload={onUpload}
        />
      )}

      {/* ── Confirmação de exclusão em massa ── */}
      {confirmDelete && (
        <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setConfirmDelete(null); }}>
          <section className="modal-card danger-modal">
            <span className="sheet-handle" />
            <button className="modal-close" type="button" onClick={() => setConfirmDelete(null)}><X size={25} /></button>
            <span className="danger-icon"><CircleAlert size={36} /></span>
            <h2>Excluir itens</h2>
            <p className="centered-text">
              Excluir <strong>{confirmDelete.length} {confirmDelete.length === 1 ? 'item' : 'itens'}</strong> da fatura?<br />
              Esta ação não pode ser desfeita.
            </p>
            <div className="modal-actions">
              <button className="ghost" type="button" onClick={() => setConfirmDelete(null)}>Cancelar</button>
              <button className="danger-button" type="button" onClick={() => {
                onBulkDelete(confirmDelete, exitBulk);
                setConfirmDelete(null);
              }}>
                Excluir definitivamente
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function HistoryPage({ items, totals, invoices, closingDay, onLoadMonthItems, onOpenInvoice, onUpload, allInstallmentItems = [] }) {
  const monthNamesShort = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const monthNamesFull = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  // Período de faturamento atual — ex.: junho/2026 quando o cartão fechou dia 15/mai
  const { monthIndex: billingMonthIndex, year: billingYear } = getInvoiceMonthYear(closingDay);

  const [selectedMonthIndex, setSelectedMonthIndex] = useState(billingMonthIndex);
  const [selectedYear, setSelectedYear] = useState(billingYear);
  const [yearOpen, setYearOpen] = useState(false);
  const [loadedItems, setLoadedItems] = useState(null);  // itens carregados do banco para meses passados
  const [histLoading, setHistLoading] = useState(false);
  const stripRef = useRef(null);
  const stripFirstRender = useRef(true);

  // monthDiff relativo ao período de faturamento (0 = atual, <0 = passado, >0 = futuro)
  const monthDiff = (selectedYear - billingYear) * 12 + (selectedMonthIndex - billingMonthIndex);
  const isBillingPeriod = monthDiff === 0;
  const isPast = monthDiff < 0;
  const isFuture = monthDiff > 0;

  // Carrega itens do banco quando navega para um mês passado
  useEffect(() => {
    if (!isPast) { setLoadedItems(null); return; }
    setHistLoading(true);
    setLoadedItems(null);
    onLoadMonthItems(selectedMonthIndex + 1, selectedYear).then((loaded) => {
      setLoadedItems(loaded || []);
      setHistLoading(false);
    });
  }, [selectedMonthIndex, selectedYear]);

  const displayItems = useMemo(() => {
    if (isPast) {
      // Ainda carregando → aguarda
      if (loadedItems === null) return [];
      // Tem itens reais da fatura → mostra-os
      if (loadedItems.length) return loadedItems;
      // Mês passado SEM fatura carregada → projeta parcelas de faturas anteriores
      return getForecastItemsForMonth(allInstallmentItems, selectedMonthIndex + 1, selectedYear, closingDay);
    }

    // Período atual e meses futuros: projeta parcelas de faturas anteriores
    const projected = getForecastItemsForMonth(allInstallmentItems, selectedMonthIndex + 1, selectedYear, closingDay);

    if (!isBillingPeriod) return projected; // futuro → só projeções

    // Período atual: mescla itens reais da fatura aberta + projeções,
    // removendo projeções de itens que já constam na fatura real (evita duplicatas)
    const dedupedProjected = projected.filter((proj) =>
      !items.some(
        (real) =>
          real.description === proj.description &&
          Math.abs(Number(real.amount) - Number(proj.amount)) < 0.01,
      ),
    );
    return [...items, ...dedupedProjected];
  }, [items, monthDiff, isBillingPeriod, isPast, loadedItems, allInstallmentItems, selectedMonthIndex, selectedYear, closingDay]);

  const displayTotal = useMemo(() => displayItems.reduce((s, i) => s + Number(i.amount), 0), [displayItems]);

  // Usa displayTotal sempre: inclui itens reais + projeções de parcelas em aberto
  const displayMine = displayTotal;

  // Status do chip do mês: baseado nas faturas reais no banco (campo invoices[])
  function getMonthStatus(index, year) {
    const diff = (year - billingYear) * 12 + (index - billingMonthIndex);
    if (diff === 0) return 'current';
    if (diff > 0) {
      const hasForecast = getForecastItemsForMonth(allInstallmentItems, index + 1, year, closingDay).length > 0;
      return hasForecast ? 'forecast' : 'empty';
    }
    // Passado: verifica se há fatura no banco para este mês/ano
    const month = index + 1;
    const hasInvoice = invoices.some((inv) => inv.month === month && inv.year === year);
    if (hasInvoice) return 'closed';
    // Sem fatura → verifica se há projeções de parcelas de meses anteriores
    const hasForecast = getForecastItemsForMonth(allInstallmentItems, index + 1, year, closingDay).length > 0;
    return hasForecast ? 'forecast' : 'empty';
  }

  function navigate(direction) {
    let newIndex = selectedMonthIndex + direction;
    let newYear = selectedYear;
    if (newIndex < 0) { newIndex = 11; newYear--; }
    if (newIndex > 11) { newIndex = 0; newYear++; }
    setSelectedMonthIndex(newIndex);
    setSelectedYear(newYear);
  }

  // Centra o mês selecionado no carrossel (mobile)
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const chip = strip.children[selectedMonthIndex];
    if (!chip) return;
    const behavior = stripFirstRender.current ? 'auto' : 'smooth';
    stripFirstRender.current = false;
    strip.scrollTo({ left: chip.offsetLeft - strip.clientWidth / 2 + chip.offsetWidth / 2, behavior });
  }, [selectedMonthIndex, selectedYear]);

  const status = getMonthStatus(selectedMonthIndex, selectedYear);
  const statusLabel = { closed: 'Fechada', current: 'Atual', forecast: 'Previsão', empty: 'Sem dados' }[status];
  // Mês passado sem fatura no banco → mostra CTA de subir fatura
  const isPastNoInvoice = isPast && !histLoading && status === 'empty';

  return (
    <div className="page-stack history-stack">

      {/* ── Métricas fora do flex container — mesmo contexto que Carteira ── */}
      <section className="metric-grid wallet-grid">
        <Metric
          icon={FileText}
          title="Minha parte"
          value={histLoading ? '…' : (isPastNoInvoice ? 'R$ 0,00' : money(displayMine))}
        />
        <Metric
          icon={List}
          title="Lançamentos"
          value={histLoading ? '…' : (isPastNoInvoice ? '—' : String(displayItems.length))}
        />
      </section>

      <div className="history-page">

        {/* ── Card de navegação: seletor de ano + legenda + strip de meses ── */}
        <div className="history-nav-card">
          <div className="history-nav-top">
            <div
              className="year-selector-wrap"
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setYearOpen(false); }}
            >
              <button
                className="year-selector-btn"
                type="button"
                onClick={() => setYearOpen((o) => !o)}
              >
                <CalendarDays size={16} />
                {selectedYear}
                <ChevronDown size={14} className={`year-chevron${yearOpen ? ' open' : ''}`} />
              </button>
              {yearOpen && (
                <div className="year-dropdown">
                  {[billingYear - 2, billingYear - 1, billingYear, billingYear + 1].map((y) => (
                    <button
                      key={y}
                      className={y === selectedYear ? 'active' : ''}
                      type="button"
                      onClick={() => { setSelectedYear(y); setYearOpen(false); }}
                    >
                      {y}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="history-legend">
              <span><span className="legend-dot closed" />Fechada</span>
              <span><span className="legend-dot forecast" />Previsão</span>
              <span><span className="legend-dot empty" />Sem fatura</span>
            </div>
          </div>

          <div className="month-strip-row">
            <button className="strip-arrow" type="button" onClick={() => navigate(-1)}><ChevronLeft size={17} /></button>
            <div className="month-strip" ref={stripRef}>
              {monthNamesShort.map((name, index) => {
                const s = getMonthStatus(index, selectedYear);
                return (
                  <button
                    key={name}
                    className={`month-chip${index === selectedMonthIndex ? ' active' : ''} chip-${s}`}
                    type="button"
                    onClick={() => setSelectedMonthIndex(index)}
                  >
                    <span className="chip-dot" />
                    <span>{name}</span>
                  </button>
                );
              })}
            </div>
            <button className="strip-arrow" type="button" onClick={() => navigate(1)}><ChevronRight size={17} /></button>
          </div>
        </div>

        {/* ── Card de detalhe: cabeçalho + lista de itens ── */}
        <div className="history-detail-card">
          <div className="history-detail-head">
            <div className="history-detail-title">
              <h2>{monthNamesFull[selectedMonthIndex]} / {selectedYear}</h2>
              <span className={`status-pill pill-${status}`}>{statusLabel}</span>
            </div>
            <div className="history-head-actions">
              {!isFuture && (
                <button
                  className="ghost small"
                  type="button"
                  onClick={() => onOpenInvoice?.(selectedMonthIndex + 1, selectedYear)}
                >
                  <Pencil size={15} />
                  {isBillingPeriod ? 'Ir para Faturas' : 'Ver fatura'}
                </button>
              )}
              <button className="ghost small" type="button">
                <Download size={16} />Exportar
              </button>
            </div>
          </div>

          <h3 className="history-items-title">Itens da minha fatura</h3>

          {histLoading ? (
            <div className="history-empty">
              <p>Carregando…</p>
            </div>
          ) : isPastNoInvoice ? (
            <div className="history-empty">
              <FileText size={28} />
              <p>Nenhuma fatura para este mês.</p>
              <button className="ghost" type="button" onClick={onUpload}>
                <CloudUpload size={17} />Subir fatura
              </button>
            </div>
          ) : displayItems.length > 0 ? (
            <CleanTable
              mode="wallet"
              items={displayItems.map((r) => ({
                ...r,
                date: String(r.date || ''),
                installment: r.installment && r.installment !== '-' ? r.installment : '',
                mine: false,
                manual: false,
              }))}
            />
          ) : (
            <div className="history-empty">
              <CircleAlert size={28} />
              <p>Nenhum item para este mês ainda.</p>
            </div>
          )}
        </div>


      </div>
    </div>
  );
}

// ── Editor de fatura de mês passado ──────────────────────────────
// Funciona igual à aba Faturas mas opera sobre uma fatura histórica.
// Abre quando o usuário clica em "Ver fatura" no Histórico.
function HistoryEditPage({ edit, card, onBack, onToggle, onAdd, onEdit, onUpload, onBulkDelete }) {
  const monthNamesFull = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const { items, month, year, loading } = edit;
  const [search, setSearch] = useState('');
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState(new Set());
  const [confirmDelete, setConfirmDelete] = useState(null);

  const visibleItems = useMemo(
    () => items.filter((r) => r.description.toLowerCase().includes(search.toLowerCase())),
    [items, search],
  );

  const editTotals = useMemo(() => ({
    all: items.reduce((s, r) => s + Number(r.amount), 0),
    mine: items.filter((r) => r.mine).reduce((s, r) => s + Number(r.amount), 0),
    mineCount: items.filter((r) => r.mine).length,
    allCount: items.length,
  }), [items]);

  function toggleBulkSelect(id) {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function handleBulkToggleAll(ids, select) {
    setBulkSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => (select ? next.add(id) : next.delete(id)));
      return next;
    });
  }

  function exitBulk() { setBulkMode(false); setBulkSelected(new Set()); }

  return (
    <div className="page-stack invoices-stack">

      {/* ── Barra de voltar + título do mês ── */}
      <div className="hist-edit-header">
        <button className="ghost small hist-back-btn" type="button" onClick={onBack}>
          <ChevronLeft size={18} />Histórico
        </button>
        <div className="hist-edit-title">
          <h2 className="hist-edit-month">{monthNamesFull[month - 1]} / {year}</h2>
          <span className="hist-closed-badge">Fechada</span>
        </div>
      </div>

      {/* ── Métricas ── */}
      <section className="metric-grid wallet-grid">
        <Metric icon={FileText} title="Total da fatura" value={loading ? '…' : money(editTotals.all)} />
        <Metric icon={UserRound} title="Minha parte" value={loading ? '…' : money(editTotals.mine)} />
      </section>

      {loading ? (
        <div className="history-empty" style={{ marginTop: 32 }}>
          <p>Carregando fatura…</p>
        </div>
      ) : (
        <>
          <div className="action-row no-upload">
            <button className="primary add-item-btn" type="button" onClick={onAdd}>
              <Plus size={19} />Adicionar item
            </button>
            <button className="ghost small filters-btn" type="button">
              <Filter size={18} /><span className="filters-label">Filtros</span>
            </button>
            <label className="search-field">
              <Search size={18} />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar descrição" />
            </label>
          </div>

          {/* ── Linha de seção com controles de seleção em massa ── */}
          <div className="section-title-row">
            <SectionTitle title="Fatura completa" />
            {!bulkMode ? (
              <button className="ghost small bulk-select-trigger" type="button" onClick={() => setBulkMode(true)}>
                <CheckSquare size={16} />Selecionar
              </button>
            ) : (
              <div className="bulk-row-controls">
                <span className="bulk-count">{bulkSelected.size} selecionado{bulkSelected.size !== 1 ? 's' : ''}</span>
                <button className="ghost small" type="button" onClick={exitBulk}><X size={16} />Cancelar</button>
                {bulkSelected.size > 0 && (
                  <button className="danger-button small" type="button" onClick={() => setConfirmDelete([...bulkSelected])}>
                    <Trash2 size={16} />Excluir ({bulkSelected.size})
                  </button>
                )}
              </div>
            )}
          </div>

          <CleanTable
            mode="invoice"
            items={visibleItems}
            onToggle={onToggle}
            onEdit={onEdit}
            bulkMode={bulkMode}
            bulkSelected={bulkSelected}
            onBulkToggle={toggleBulkSelect}
            onBulkToggleAll={handleBulkToggleAll}
          />
          {!bulkMode && (
            <SummaryBar
              icon={List}
              count={editTotals.mineCount}
              countSuffix={editTotals.allCount}
              label="itens selecionados"
              secondaryAction="Adicionar item"
              onSecondary={onAdd}
              uploadAction="Subir fatura"
              onUpload={onUpload}
              action="Voltar ao Histórico"
              onAction={onBack}
            />
          )}

          {/* ── Confirmação de exclusão em massa ── */}
          {confirmDelete && (
            <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setConfirmDelete(null); }}>
              <section className="modal-card danger-modal">
                <span className="sheet-handle" />
                <button className="modal-close" type="button" onClick={() => setConfirmDelete(null)}><X size={25} /></button>
                <span className="danger-icon"><CircleAlert size={36} /></span>
                <h2>Excluir itens</h2>
                <p className="centered-text">
                  Excluir <strong>{confirmDelete.length} {confirmDelete.length === 1 ? 'item' : 'itens'}</strong> da fatura?<br />
                  Esta ação não pode ser desfeita.
                </p>
                <div className="modal-actions">
                  <button className="ghost" type="button" onClick={() => setConfirmDelete(null)}>Cancelar</button>
                  <button className="danger-button" type="button" onClick={() => {
                    onBulkDelete(confirmDelete, exitBulk);
                    setConfirmDelete(null);
                  }}>
                    Excluir definitivamente
                  </button>
                </div>
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CollapsibleCard({ title, subtitle, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="settings-card">
      <button className="collapsible-trigger" type="button" onClick={() => setOpen((o) => !o)}>
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="collapsible-sub">{subtitle}</p>}
        </div>
        <ChevronDown size={20} className={`collapsible-chevron${open ? ' open' : ''}`} />
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </section>
  );
}

/* ── Modal de edição da conta (dados + senha) ───────────────────── */
function EditAccountModal({ session, profileName, onClose, onSaveProfile }) {
  const email = session?.user?.email || '';
  const phone = session?.user?.user_metadata?.phone_number || '';
  const [tab, setTab] = useState('dados'); // 'dados' | 'senha'

  // ── Aba dados ──
  const [editDraft, setEditDraft]   = useState({ name: profileName || '', email, phone });
  const [editStatus, setEditStatus] = useState('');

  async function handleSaveEdit() {
    setEditStatus('saving');
    try {
      if (editDraft.name !== (profileName || '')) await onSaveProfile?.(editDraft.name);
      const authChanges = {};
      if (editDraft.email !== email) authChanges.email = editDraft.email;
      if (editDraft.phone !== phone) authChanges.phone = editDraft.phone;
      if (Object.keys(authChanges).length) await db.updateUserInfo(authChanges);
      setEditStatus('saved');
      setTimeout(() => onClose(), 1400);
    } catch (e) { setEditStatus('error:' + e.message); }
  }

  // ── Aba senha ──
  // Etapas: 'verify' → usuário digita senha atual → 'change' → digita nova senha
  const [pwStep, setPwStep]     = useState('verify'); // 'verify' | 'change'
  const [pwDraft, setPwDraft]   = useState({ current: '', next: '', confirm: '' });
  const [pwStatus, setPwStatus] = useState('');

  async function handleVerifyCurrent() {
    if (!pwDraft.current) { setPwStatus('error:Digite sua senha atual'); return; }
    setPwStatus('checking');
    const { error } = await db.signIn(email, pwDraft.current);
    if (error) { setPwStatus('error:Senha atual incorreta'); return; }
    setPwStatus('');
    setPwStep('change');
  }

  async function handleSavePw() {
    if (pwDraft.next.length < 6)          { setPwStatus('error:Mínimo 6 caracteres'); return; }
    if (pwDraft.next !== pwDraft.confirm) { setPwStatus('error:As senhas não coincidem'); return; }
    setPwStatus('saving');
    const { error } = await db.updatePassword(pwDraft.next);
    if (error) { setPwStatus(`error:${error.message}`); return; }
    setPwStatus('saved');
    setTimeout(() => onClose(), 1400);
  }

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card edit-account-modal">
        <div className="sheet-handle" />
        <button className="modal-close" type="button" onClick={onClose}><X size={20} /></button>
        <h2>Editar conta</h2>

        {/* Abas */}
        <div className="edit-acct-tabs">
          <button type="button" className={tab === 'dados' ? 'active' : ''} onClick={() => setTab('dados')}>Dados</button>
          <button type="button" className={tab === 'senha' ? 'active' : ''}
            onClick={() => { setTab('senha'); setPwStep('verify'); setPwDraft({ current: '', next: '', confirm: '' }); setPwStatus(''); }}>Senha</button>
        </div>

        {tab === 'dados' && (
          <div className="modal-form">
            <Field label="Nome"     value={editDraft.name}  onChange={(v) => setEditDraft((d) => ({ ...d, name: v }))} />
            <Field label="E-mail"   value={editDraft.email} onChange={(v) => setEditDraft((d) => ({ ...d, email: v }))} />
            <Field label="Telefone" value={editDraft.phone} onChange={(v) => setEditDraft((d) => ({ ...d, phone: v }))} />
            {editDraft.email !== email && (
              <p className="account-msg info">Um e-mail de confirmação será enviado para o novo endereço.</p>
            )}
            {editStatus.startsWith('error:') && <p className="account-msg error">{editStatus.slice(6)}</p>}
            {editStatus === 'saved'           && <p className="account-msg success">Dados atualizados!</p>}
            <div className="modal-actions">
              <button className="ghost" type="button" onClick={onClose}>Cancelar</button>
              <button className="primary" type="button" disabled={editStatus === 'saving'} onClick={handleSaveEdit}>
                {editStatus === 'saving' ? 'Salvando…' : 'Salvar'}
              </button>
            </div>
          </div>
        )}

        {tab === 'senha' && pwStep === 'verify' && (
          <div className="modal-form">
            <Field label="Senha atual" type="password" value={pwDraft.current}
              onChange={(v) => { setPwDraft((d) => ({ ...d, current: v })); setPwStatus(''); }} />
            {pwStatus.startsWith('error:') && <p className="account-msg error">{pwStatus.slice(6)}</p>}
            <div className="modal-actions">
              <button className="ghost" type="button" onClick={onClose}>Cancelar</button>
              <button className="primary" type="button"
                disabled={pwStatus === 'checking'}
                onClick={handleVerifyCurrent}>
                {pwStatus === 'checking' ? 'Verificando…' : 'Continuar'}
              </button>
            </div>
          </div>
        )}

        {tab === 'senha' && pwStep === 'change' && (
          <div className="modal-form">
            <Field label="Nova senha"           type="password" value={pwDraft.next}    onChange={(v) => { setPwDraft((d) => ({ ...d, next: v })); setPwStatus(''); }} />
            <Field label="Confirmar nova senha" type="password" value={pwDraft.confirm} onChange={(v) => { setPwDraft((d) => ({ ...d, confirm: v })); setPwStatus(''); }} />
            {pwStatus.startsWith('error:') && <p className="account-msg error">{pwStatus.slice(6)}</p>}
            {pwStatus === 'saved'           && <p className="account-msg success">Senha alterada com sucesso!</p>}
            <div className="modal-actions">
              <button className="ghost" type="button"
                onClick={() => { setPwStep('verify'); setPwDraft((d) => ({ ...d, next: '', confirm: '' })); setPwStatus(''); }}>
                Voltar
              </button>
              <button className="primary" type="button" disabled={pwStatus === 'saving'} onClick={handleSavePw}>
                {pwStatus === 'saving' ? 'Salvando…' : 'Salvar senha'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Card "Minha conta" na aba Ajustes (simplificado) ───────────── */
function AccountCard({ session, profileName, onSignOut, onEditAccount }) {
  const email    = session?.user?.email || '';
  const initials = (profileName || email || 'U').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <section className="settings-card account-card">
      <h1 className="account-card-title">Minha conta</h1>
      <div className="account-header">
        <span className="account-avatar">{initials}</span>
        <div className="account-info">
          <strong className="account-name">{profileName || 'Usuário'}</strong>
          <span className="account-email">{email}</span>
        </div>
      </div>
      <div className="account-actions">
        <button className="ghost small account-edit-btn" type="button" onClick={onEditAccount}>
          <Settings size={15} /> Editar conta
        </button>
        <button className="danger-link account-signout" type="button" onClick={onSignOut}>
          <LogOut size={15} /> Sair da conta
        </button>
      </div>
    </section>
  );
}

const THEMES = [
  { id: 'ocean',  label: 'Azul oceano' },
  { id: 'orange', label: 'Laranja'     },
  { id: 'purple', label: 'Roxo'        },
];

function SettingsPage({ session, card, profileName, notifications, theme = 'ocean', onTheme, onSignOut, onChangeCard, onSaveProfile, onNotifications, onSaveNotifications, onDelete, onEditAccount, focusNotif = 0 }) {
  const [draft, setDraft] = useState(card);
  const [profileDraft, setProfileDraft] = useState(profileName || '');
  const [saveStatus, setSaveStatus] = useState('idle'); // 'idle' | 'saving' | 'saved'
  const notifRef = useRef(null);
  const savedCardRef    = useRef(card);
  const savedProfileRef = useRef(profileName || '');

  // Troca de cartão → reseta draft do cartão
  useEffect(() => {
    if (!card) return;
    setDraft(card);
    savedCardRef.current = card;
    setSaveStatus('idle');
  }, [card?.id]);

  // Sincroniza profileDraft quando o prop muda (ex.: carregamento inicial)
  useEffect(() => {
    setProfileDraft(profileName || '');
    savedProfileRef.current = profileName || '';
  }, [profileName]);

  // Autosave do CARTÃO com debounce 800ms
  useEffect(() => {
    if (!draft) return;
    if (JSON.stringify(draft) === JSON.stringify(savedCardRef.current)) return;
    setSaveStatus('saving');
    const timer = setTimeout(async () => {
      savedCardRef.current = { ...draft };
      await onChangeCard(draft);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2500);
    }, 800);
    return () => clearTimeout(timer);
  }, [draft]);

  // Autosave do PERFIL com debounce 800ms
  useEffect(() => {
    if (profileDraft === savedProfileRef.current) return;
    setSaveStatus('saving');
    const timer = setTimeout(async () => {
      savedProfileRef.current = profileDraft;
      if (onSaveProfile) await onSaveProfile(profileDraft);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2500);
    }, 800);
    return () => clearTimeout(timer);
  }, [profileDraft]);

  // Scroll para a seção de Notificações quando ativado via engrenagem do balão
  useEffect(() => {
    if (!focusNotif) return;
    const timer = setTimeout(() => {
      notifRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80); // aguarda a expansão do card
    return () => clearTimeout(timer);
  }, [focusNotif]);

  if (!card) return null;

  function updateDraft(patch) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  async function handleNotifChange(next) {
    onNotifications(next);
    setSaveStatus('saving');
    if (onSaveNotifications) {
      await onSaveNotifications(next);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2500);
    }
  }

  return (
    <div className="settings-page">
      <div className="autosave-status">
        {saveStatus === 'saving' && <span className="autosave-indicator saving"><span className="spinner-dot" />Salvando…</span>}
        {saveStatus === 'saved'  && <span className="autosave-indicator saved"><Check size={14} />Salvo</span>}
      </div>

      {/* ── Minha conta ── */}
      <AccountCard session={session} profileName={profileName} onSignOut={onSignOut} onEditAccount={onEditAccount} />

      {/* ── Ajustes do usuário ── */}
      <CollapsibleCard title="Ajustes do usuário" subtitle="Personalize sua experiência no DivideConta." defaultOpen={false}>
        <Field
          label="Nome do usuário"
          value={profileDraft}
          onChange={setProfileDraft}
        />
        <h3 className="settings-section-title">Cor geral / tema</h3>
        <div className="theme-list">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-chip${theme === t.id ? ' active' : ''}`}
              type="button"
              onClick={() => onTheme?.(t.id)}
            >
              <span className={`swatch swatch-${t.id}`} />
              {t.label}
              {theme === t.id && <Check size={15} />}
            </button>
          ))}
        </div>
      </CollapsibleCard>

      {/* ── Ajustes do cartão ── */}
      <CollapsibleCard title="Ajustes do cartão" subtitle="Edite as informações do seu cartão." defaultOpen={false}>
        <div className="form-grid">
          <Field label="Nome do cartão" value={draft.name} onChange={(name) => updateDraft({ name })} />
          <Field label="Finais do cartão" value={draft.last4} onChange={(last4) => updateDraft({ last4 })} />
          <Field label="Titular do cartão" value={draft.owner} onChange={(owner) => updateDraft({ owner })} />
          <DatePickerField label="Data de fechamento" value={draft.closeDate} onChange={(closeDate) => updateDraft({ closeDate })} />
          <DatePickerField label="Data de vencimento no" value={draft.dueDate} onChange={(dueDate) => updateDraft({ dueDate })} />
        </div>
        <BankChips value={draft.bank} onChange={(bank) => updateDraft({ bank })} />
        <BrandChips value={draft.brand} onChange={(brand) => updateDraft({ brand })} />
        <div className="settings-actions">
          <button className="danger-link" type="button" onClick={onDelete}><Trash2 size={18} />Excluir cartão</button>
        </div>
      </CollapsibleCard>

      {/* ── Notificações ── */}
      <div ref={notifRef}>
        <CollapsibleCard key={`notif-${focusNotif}`} title="Notificações" subtitle="Gerencie os alertas que você deseja receber." defaultOpen={focusNotif > 0}>
          <NotificationPanel values={notifications} onChange={handleNotifChange} />
        </CollapsibleCard>
      </div>
    </div>
  );
}

function Metric({ icon: Icon, title, value, subtitle, badge }) {
  return (
    <article className="metric-card">
      <span className="round-icon"><Icon size={34} /></span>
      <div>
        <p>{title}</p>
        <strong>{value}</strong>
        {subtitle && <small>{subtitle}</small>}
        {badge && <span className="ok-pill"><Check size={15} />{badge}</span>}
      </div>
    </article>
  );
}

function ReceiptIcon(props) {
  return <FileText {...props} />;
}

function SectionTitle({ title }) {
  return <h1 className="section-title">{title}</h1>;
}

function CleanTable({ items, mode, compact, onToggle, onEdit, bulkMode = false, bulkSelected, onBulkToggle, onBulkToggleAll }) {
  // ── Ordenação por coluna ───────────────────────────────────────
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('desc');

  function handleSort(key, defaultDir) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(defaultDir);
    }
  }

  function SortIcon({ colKey }) {
    if (sortKey !== colKey) return <span className="sort-off">⇅</span>;
    return <span className="sort-on">{sortDir === 'asc' ? '▴' : '▾'}</span>;
  }

  const sorted = useMemo(() => {
    if (!sortKey) return items;
    return [...items].sort((a, b) => {
      let v = 0;
      if (sortKey === 'date') {
        const p = (s) => {
          const parts = (s || '').split('/');
          if (parts.length === 3) return +parts[2] * 10000 + +parts[1] * 100 + +parts[0];
          if (parts.length === 2) return +parts[1] * 100 + +parts[0];
          return 0;
        };
        v = p(a.date) - p(b.date);
      } else if (sortKey === 'description') {
        v = (a.description || '').localeCompare(b.description || '', 'pt-BR', { sensitivity: 'base' });
      } else if (sortKey === 'installment') {
        const p = (s) => {
          if (!s || s === '-') return 0;
          const parts = s.split('/');
          return parseInt(parts[1] || parts[0]) || 0;
        };
        v = p(a.installment) - p(b.installment);
      } else if (sortKey === 'amount') {
        const p = (x) => {
          if (typeof x === 'number') return x;
          return parseFloat(String(x).replace(/[^\d,.]/g, '').replace(',', '.')) || 0;
        };
        v = p(a.amount) - p(b.amount);
      }
      return sortDir === 'asc' ? v : -v;
    });
  }, [items, sortKey, sortDir]);

  // ── Suporte a seleção em massa ─────────────────────────────────
  const allBulkSelected = bulkMode && sorted.length > 0 && sorted.every((r) => bulkSelected?.has(r.id));

  function handleHeaderCheck() {
    const ids = sorted.map((r) => r.id);
    onBulkToggleAll?.(ids, !allBulkSelected);
  }

  return (
    <section className={`table-card ${compact ? 'compact' : ''}`}>
      <div className={`table-header ${mode}`}>
        {mode === 'invoice' && (
          bulkMode
            ? <button className="check-cell" type="button" title="Selecionar todos" onClick={handleHeaderCheck}>
                {allBulkSelected && <Check size={15} />}
              </button>
            : <span />
        )}
        <span className="sortable" onClick={() => handleSort('date', 'desc')}>
          Data <SortIcon colKey="date" />
        </span>
        <span className="sortable" onClick={() => handleSort('description', 'asc')}>
          Descrição <SortIcon colKey="description" />
        </span>
        <span className="sortable" onClick={() => handleSort('installment', 'desc')}>
          Parcela <SortIcon colKey="installment" />
        </span>
        <span className="sortable" onClick={() => handleSort('amount', 'desc')}>
          Valor (R$) <SortIcon colKey="amount" />
        </span>
        {mode === 'invoice' && <span>{bulkMode ? '' : 'Ações'}</span>}
      </div>
      {items.length === 0 && (
        <div className="table-empty">
          <FileText size={32} />
          <p>Nenhum item ainda. Suba uma fatura ou adicione manualmente.</p>
        </div>
      )}
      {sorted.map((row) => {
        const isBulkSelected = bulkSelected?.has(row.id);
        const rowClass = bulkMode
          ? `table-line ${mode}${isBulkSelected ? ' bulk-selected' : ''}`
          : `table-line ${mode}${row.mine ? ' selected' : ''}`;
        return (
          <div className={rowClass} key={row.id}>
            {mode === 'invoice' && (
              bulkMode
                ? <button className="check-cell" type="button" onClick={() => onBulkToggle?.(row.id)}>
                    {isBulkSelected && <Check size={15} />}
                  </button>
                : <button className="check-cell" type="button" onClick={() => onToggle(row.id)}>
                    {row.mine && <Check size={15} />}
                  </button>
            )}
            <span className="date-cell" data-short={(row.date || '').slice(0, 5)}>{row.date}</span>
            <strong>{row.description}{row.manual && <em>Manual</em>}</strong>
            <span>{row.installment}</span>
            <b>{amountOnly(row.amount)}</b>
            {mode === 'invoice' && !bulkMode && (
              <button className="edit-button" type="button" onClick={() => onEdit(row)} aria-label="Editar item">
                <Pencil size={18} />
              </button>
            )}
            {mode === 'invoice' && bulkMode && <span />}
          </div>
        );
      })}
    </section>
  );
}

function SummaryBar({ icon: Icon, count, countSuffix, label, totalLabel, total, action, onAction, secondaryAction, onSecondary, uploadAction, onUpload }) {
  const hasCount  = count !== undefined;
  const isMinimal = !hasCount && !total;
  const hasUpload = Boolean(uploadAction);
  const cls = [
    'summary-bar',
    secondaryAction ? 'with-secondary' : '',
    isMinimal       ? 'bar-minimal'    : '',
    hasUpload       ? 'with-upload'    : '',
  ].filter(Boolean).join(' ');

  return (
    <section className={cls}>
      {/* Lado esquerdo: info | secondaryAction (quando sem contagem) | spacer */}
      {hasCount ? (
        <span className="summary-copy">
          {Icon && <Icon size={20} className="summary-copy-icon" />}
          <span>
            <strong>
              {count}
              {countSuffix !== undefined && <em className="count-suffix"> de {countSuffix}</em>}
            </strong>
            {label && (
              <small>
                {label.split(' ')[0]}
                {label.includes(' ') && <span className="label-optional"> {label.split(' ').slice(1).join(' ')}</span>}
              </small>
            )}
          </span>
        </span>
      ) : secondaryAction ? (
        <button className="ghost desktop-summary-action" type="button" onClick={onSecondary}>
          {secondaryAction}
        </button>
      ) : (
        <span className="summary-spacer" aria-hidden="true" />
      )}

      {/* Total (opcional — mantido para uso futuro) */}
      {total && (
        <span className="summary-total"><small>{totalLabel}</small><strong>{total}</strong></span>
      )}

      {/* Ação secundária quando há contagem (fica entre o count e o botão primário) */}
      {secondaryAction && hasCount && (
        <button className="ghost desktop-summary-action" type="button" onClick={onSecondary}>
          {secondaryAction}
        </button>
      )}

      {/* Botão de upload dentro da barra (ex.: Subir fatura) */}
      {hasUpload && (
        <button className="ghost summary-upload" type="button" onClick={onUpload}>
          <CloudUpload size={18} /><span>{uploadAction}</span>
        </button>
      )}

      {/* Ação primária */}
      <button className="primary summary-action" type="button" onClick={onAction}>
        {action}<ChevronRight size={26} />
      </button>
    </section>
  );
}


/* ── Máscara de moeda estilo ATM ─────────────────────────────────
   value  : número float (ex: 3.5 → exibe "R$ 3,50")
   onChange: recebe float atualizado
   Dígitos empurram da direita; Backspace puxa de volta; Delete zera. */
function CurrencyField({ label, value, onChange }) {
  const [cents, setCents] = useState(() => Math.round(Number(value || 0) * 100));

  function fmt(c) {
    const n = Math.max(0, Math.floor(c));
    const s = String(n).padStart(3, '0');
    const dec = s.slice(-2);
    const int = parseInt(s.slice(0, -2), 10).toLocaleString('pt-BR');
    return `R$ ${int},${dec}`;
  }

  function commit(next) {
    const v = Math.min(Math.max(0, next), 99999999); // max R$ 999.999,99
    setCents(v);
    onChange(v / 100);
  }

  function handleKeyDown(e) {
    if (e.key >= '0' && e.key <= '9') {
      e.preventDefault();
      commit(cents * 10 + parseInt(e.key, 10));
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      commit(Math.floor(cents / 10));
    } else if (e.key === 'Delete') {
      e.preventDefault();
      commit(0);
    }
    // Tab, setas etc. passam normalmente
  }

  // Fallback para teclado virtual mobile (onKeyDown pode não disparar)
  function handleChange(e) {
    const digits = e.target.value.replace(/\D/g, '');
    commit(Math.min(parseInt(digits || '0', 10), 99999999));
  }

  // Paste: extrai dígitos e assume os últimos 2 como centavos
  function handlePaste(e) {
    e.preventDefault();
    const text = e.clipboardData.getData('text');
    const digits = text.replace(/\D/g, '');
    commit(Math.min(parseInt(digits || '0', 10), 99999999));
  }

  return (
    <label className="field">
      <span>{label}</span>
      <i className="currency-field-wrap">
        <input
          type="text"
          inputMode="numeric"
          value={fmt(cents)}
          onKeyDown={handleKeyDown}
          onChange={handleChange}
          onPaste={handlePaste}
        />
      </i>
    </label>
  );
}

/* ── DatePickerField — calendário flutuante ─────────────────────
   value  : string "DD/MM/AAAA" (ou vazio)
   onChange: recebe string "DD/MM/AAAA" */
function DatePickerField({ label, value, onChange }) {
  const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const WDAYS  = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];

  const todayStr = getTodayFormatted();

  function parseValue(v) {
    const today = new Date();
    if (!v) return { day: today.getDate(), month: today.getMonth() + 1, year: today.getFullYear() };
    const parts = v.split('/').map(Number);
    if (parts.length !== 3 || parts.some((n) => isNaN(n) || n === 0))
      return { day: today.getDate(), month: today.getMonth() + 1, year: today.getFullYear() };
    return { day: parts[0], month: parts[1], year: parts[2] };
  }

  const parsed = parseValue(value);
  const [open, setOpen]         = useState(false);
  const [view, setView]         = useState('days');   // 'days' | 'months' | 'years'
  const [cursor, setCursor]     = useState({ month: parsed.month, year: parsed.year });
  const [popStyle, setPopStyle] = useState({});
  const triggerRef = useRef(null);
  const popRef     = useRef(null);

  function openPicker() {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const PW = 240; // largura fixa do popup
    const pickerH = 260;
    const spaceBelow = window.innerHeight - rect.bottom;
    const top  = spaceBelow >= pickerH + 8 ? rect.bottom + 4 : rect.top - pickerH - 4;
    const left = Math.min(rect.left, window.innerWidth - PW - 8);
    setPopStyle({ top, left, width: PW });
    const p = parseValue(value);
    setCursor({ month: p.month, year: p.year });
    setView('days');
    setOpen(true);
  }

  useEffect(() => {
    if (!open) return;
    function close(e) {
      if (
        popRef.current && !popRef.current.contains(e.target) &&
        triggerRef.current && !triggerRef.current.contains(e.target)
      ) setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', close, true);
    document.addEventListener('touchstart', close, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('touchstart', close, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  function selectDate(d) {
    const dd = String(d).padStart(2, '0');
    const mm = String(cursor.month).padStart(2, '0');
    onChange(`${dd}/${mm}/${cursor.year}`);
    setOpen(false);
  }

  function buildDays() {
    const firstDay    = new Date(cursor.year, cursor.month - 1, 1).getDay();
    const daysInMonth = new Date(cursor.year, cursor.month, 0).getDate();
    const cells = Array(firstDay).fill(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    return cells;
  }

  function buildYears() {
    const base = Math.floor(cursor.year / 12) * 12;
    return Array.from({ length: 12 }, (_, i) => base + i);
  }

  const cells    = buildDays();
  const years    = buildYears();
  const yearBase = Math.floor(cursor.year / 12) * 12;

  return (
    <>
      <label className="field dp-trigger" ref={triggerRef} onClick={openPicker}>
        <span>{label}</span>
        <i>
          <CalendarDays size={17} />
          <input
            type="text"
            value={value || ''}
            readOnly
            placeholder="DD/MM/AAAA"
          />
        </i>
      </label>

      {open && createPortal(
        <div className="dp-popup" ref={popRef} style={popStyle}>

          {view === 'days' && <>
            <div className="dp-header">
              <button type="button" className="dp-nav"
                onClick={() => setCursor((c) => c.month === 1 ? { month: 12, year: c.year - 1 } : { ...c, month: c.month - 1 })}>‹</button>
              <button type="button" className="dp-title" onClick={() => setView('months')}>
                {MONTHS[cursor.month - 1]} {cursor.year}
              </button>
              <button type="button" className="dp-nav"
                onClick={() => setCursor((c) => c.month === 12 ? { month: 1, year: c.year + 1 } : { ...c, month: c.month + 1 })}>›</button>
            </div>
            <div className="dp-wdays">{WDAYS.map((w) => <span key={w}>{w}</span>)}</div>
            <div className="dp-grid">
              {cells.map((d, i) => {
                if (d === null) return <span key={`e${i}`} />;
                const dStr = `${String(d).padStart(2,'0')}/${String(cursor.month).padStart(2,'0')}/${cursor.year}`;
                return (
                  <button key={d} type="button"
                    className={`dp-day${dStr === value ? ' selected' : ''}${dStr === todayStr ? ' today' : ''}`}
                    onClick={() => selectDate(d)}
                  >{d}</button>
                );
              })}
            </div>
          </>}

          {view === 'months' && <>
            <div className="dp-header">
              <button type="button" className="dp-nav" onClick={() => setCursor((c) => ({ ...c, year: c.year - 1 }))}>‹</button>
              <button type="button" className="dp-title" onClick={() => setView('years')}>{cursor.year}</button>
              <button type="button" className="dp-nav" onClick={() => setCursor((c) => ({ ...c, year: c.year + 1 }))}>›</button>
            </div>
            <div className="dp-months">
              {MONTHS.map((m, i) => (
                <button key={m} type="button"
                  className={`dp-month${cursor.month === i + 1 ? ' selected' : ''}`}
                  onClick={() => { setCursor((c) => ({ ...c, month: i + 1 })); setView('days'); }}
                >{m}</button>
              ))}
            </div>
          </>}

          {view === 'years' && <>
            <div className="dp-header">
              <button type="button" className="dp-nav" onClick={() => setCursor((c) => ({ ...c, year: c.year - 12 }))}>‹</button>
              <button type="button" className="dp-title">{yearBase} – {yearBase + 11}</button>
              <button type="button" className="dp-nav" onClick={() => setCursor((c) => ({ ...c, year: c.year + 12 }))}>›</button>
            </div>
            <div className="dp-years">
              {years.map((y) => (
                <button key={y} type="button"
                  className={`dp-year${cursor.year === y ? ' selected' : ''}`}
                  onClick={() => { setCursor((c) => ({ ...c, year: y })); setView('months'); }}
                >{y}</button>
              ))}
            </div>
          </>}

        </div>,
        document.body
      )}
    </>
  );
}

function Field({ label, value, onChange, icon: Icon, type = 'text' }) {
  const [showPassword, setShowPassword] = useState(false);
  const inputType = type === 'password' ? (showPassword ? 'text' : 'password') : type;
  return (
    <label className="field">
      <span>{label}</span>
      <i>
        {Icon && <Icon size={17} />}
        <input type={inputType} value={value} onChange={(event) => onChange(event.target.value)} />
        {type === 'password' && (
          <button
            type="button"
            className="password-toggle"
            onClick={(e) => { e.preventDefault(); setShowPassword((s) => !s); }}
            aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
          >
            {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        )}
      </i>
    </label>
  );
}

function BrandChips({ value, onChange }) {
  const brands = [
    ['visa', 'VISA'],
    ['mastercard', 'Mastercard'],
    ['elo', 'elo'],
    ['amex', 'AMEX'],
    ['hipercard', 'Hipercard'],
  ];
  const [expanded, setExpanded] = useState(!value);
  const selectedLabel = brands.find(([id]) => id === value)?.[1] || value;
  return (
    <div className="brand-section">
      <div className="brand-section-header">
        <span>Bandeira</span>
        {value && expanded && (
          <button type="button" className="chips-expand-btn" title="Recolher" onClick={() => setExpanded(false)}>
            <ChevronUp size={18} />
          </button>
        )}
      </div>
      {value && !expanded ? (
        <div className="chips-collapsed">
          <div className="chips-selected">
            {brandVisual(value, selectedLabel)}
            <Check className="brand-check" size={16} />
          </div>
          <button type="button" className="chips-expand-btn" title="Trocar bandeira" onClick={() => setExpanded(true)}>
            <ChevronDown size={18} />
          </button>
        </div>
      ) : (
        <div className="brand-chips">
          {brands.map(([id, label]) => (
            <button
              className={value === id ? 'active' : ''}
              type="button"
              key={id}
              onClick={() => { onChange(id); setExpanded(false); }}
            >
              {brandVisual(id, label)}
              {value === id && <Check className="brand-check" size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BankChips({ value, onChange }) {
  const [expanded, setExpanded] = useState(!value);
  const selectedLabel = banks.find(([id]) => id === value)?.[1];
  return (
    <div className="brand-section">
      <div className="brand-section-header">
        <span>Banco</span>
        {value && expanded && (
          <button type="button" className="chips-expand-btn" title="Recolher" onClick={() => setExpanded(false)}>
            <ChevronUp size={18} />
          </button>
        )}
      </div>
      {value && !expanded ? (
        <div className="chips-collapsed">
          <div className="chips-selected">
            <BankBadge bank={value} />
            <span>{selectedLabel}</span>
            <Check className="brand-check" size={16} />
          </div>
          <button type="button" className="chips-expand-btn" title="Trocar banco" onClick={() => setExpanded(true)}>
            <ChevronDown size={18} />
          </button>
        </div>
      ) : (
        <div className="bank-chips">
          {banks.map(([id, label]) => (
            <button
              className={value === id ? 'active' : ''}
              type="button"
              key={id}
              onClick={() => { onChange(id); setExpanded(false); }}
            >
              <BankBadge bank={id} />
              <span>{label}</span>
              {value === id && <Check className="brand-check" size={16} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function brandVisual(id, label) {
  if (id === 'mastercard') return <><span className="mc-circles"><i /><i /></span>{label}</>;
  if (id === 'hipercard') return <em className="hiper">{label}</em>;
  return <strong className={`brand-word ${id}`}>{label}</strong>;
}

function NotificationPanel({ values, onChange, showHeader = false }) {
  const options = [
    ['closing', 'Fechamento da fatura', 'Receba um lembrete alguns dias antes do fechamento.'],
    ['due', 'Vencimento da fatura', 'Seja avisado quando a fatura estiver próxima do vencimento.'],
    ['forecast', 'Previsão disponível', 'Aviso quando a previsão de fatura estiver disponível.'],
    ['upload', 'Lembrar de subir fatura', 'Receba lembretes para não esquecer de enviar sua fatura.'],
    ['overdue', 'Fatura vencida', 'Seja avisado quando sua fatura estiver vencida.'],
  ];
  return (
    <div className="notification-panel">
      {showHeader && <h2>Notificações</h2>}
      {showHeader && <p>Gerencie os alertas que você deseja receber.</p>}
      {options.map(([key, title, description]) => (
        <label className="notification-row" key={key}>
          <span className="notify-icon"><CalendarDays size={19} /></span>
          <span><strong>{title}</strong><small>{description}</small></span>
          <input type="checkbox" checked={Boolean(values[key])} onChange={(event) => onChange({ ...values, [key]: event.target.checked })} />
        </label>
      ))}
      <div className="info-strip"><Info size={17} />As notificações aparecem no app e, quando permitido, também por push no seu dispositivo.</div>
    </div>
  );
}

// FIX: BottomNav com apenas 3 itens no mobile (sem Ajustes, acessível pelo menu hamburger)
function BottomNav({ activeTab, onTab }) {
  return (
    <nav className="bottom-nav" aria-label="Navegação mobile">
      <NavButton icon={WalletCards} label="Carteira" active={activeTab === 'carteira'} onClick={() => onTab('carteira')} />
      <NavButton icon={FileText} label="Faturas" active={activeTab === 'faturas'} onClick={() => onTab('faturas')} />
      <NavButton icon={History} label="Histórico" active={activeTab === 'historico'} onClick={() => onTab('historico')} />
      <NavButton icon={Settings} label="Ajustes" active={activeTab === 'ajustes'} onClick={() => onTab('ajustes')} />
    </nav>
  );
}

function ModalShell({ title, children, onClose, dangerIcon }) {
  return (
    <div className="modal-backdrop">
      <section className={`modal-card ${dangerIcon ? 'danger-modal' : ''}`}>
        <span className="sheet-handle" />
        <button className="modal-close" type="button" onClick={onClose}><X size={25} /></button>
        {dangerIcon && <span className="danger-icon">{dangerIcon}</span>}
        <h2>{title}</h2>
        {children}
      </section>
    </div>
  );
}

// FIX: CardModal usa data de hoje como default para datas de fechamento/vencimento
function CardModal({ onClose, onSave }) {
  const today = getTodayFormatted();
  const [draft, setDraft] = useState({
    name: '',
    last4: '',
    owner: '',
    closeDate: today,
    dueDate: today,
    bank: 'nubank',
    brand: 'mastercard',
  });
  return (
    <ModalShell title="Adicionar cartão" onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); onSave(draft); }}>
        <div className="form-grid three">
          <Field label="Nome do cartão" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
          <Field label="Finais do cartão" value={draft.last4} onChange={(last4) => setDraft({ ...draft, last4 })} />
          <Field label="Dono / referência" value={draft.owner} onChange={(owner) => setDraft({ ...draft, owner })} />
          <DatePickerField label="Data de fechamento" value={draft.closeDate} onChange={(closeDate) => setDraft({ ...draft, closeDate })} />
          <DatePickerField label="Data de vencimento" value={draft.dueDate} onChange={(dueDate) => setDraft({ ...draft, dueDate })} />
        </div>
        <BankChips value={draft.bank} onChange={(bank) => setDraft({ ...draft, bank })} />
        <BrandChips value={draft.brand} onChange={(brand) => setDraft({ ...draft, brand })} />
        <div className="modal-actions"><button className="ghost" type="button" onClick={onClose}>Cancelar</button><button className="primary" type="submit">Salvar cartão</button></div>
      </form>
    </ModalShell>
  );
}

// Calcula a parcela atual levando em conta o dia de fechamento do cartão.
// Regra: se o dia da compra >= dia de fechamento, a compra cai na fatura do MÊS SEGUINTE.
// Parcela = (mês da fatura atual) - (mês da fatura da compra) + 1
function computeCurrentInstallment(dateStr, total, closingDay = 1) {
  if (!dateStr || !total) return 1;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return 1;

  const [pd, pm, py] = parts.map(Number);
  const today  = new Date();
  const td = today.getDate();
  const tm = today.getMonth() + 1; // 1-based
  const ty = today.getFullYear();

  // Mês de fatura da compra
  // Se o dia da compra >= fechamento, cai na fatura do mês seguinte
  let pim = pm, piy = py;
  if (pd >= closingDay) {
    pim += 1;
    if (pim > 12) { pim = 1; piy += 1; }
  }

  // Mês de fatura atual
  // Se hoje >= fechamento, a fatura deste mês está fechando/fechada agora
  // → fatura atual = este mês. Se hoje < fechamento, ainda estamos na fatura deste mês também.
  // Em ambos os casos o mês de fatura atual é simplesmente o mês corrente.
  const cim = tm, ciy = ty;

  const elapsed = (ciy - piy) * 12 + (cim - pim);
  return Math.min(Math.max(1, elapsed + 1), total);
}

// FIX: ItemModal usa data de hoje e descrição vazia para novos itens
function ItemModal({ title, card, row, onClose, onSave, onDelete }) {
  const [parcelado, setParcelado] = useState(row?.installment && row.installment !== '-');
  const [draft, setDraft] = useState(row || item(`m-${Date.now()}`, getTodayFormatted(), '', '-', 0, true, true));

  // amount é controlado pelo CurrencyField diretamente no draft

  // Total de parcelas (selecionado via pills; parseia do row existente se estiver editando)
  const [totalInstallments, setTotalInstallments] = useState(() => {
    if (!row?.installment || row.installment === '-') return 1;
    return parseInt(row.installment.split('/')[1]) || 1;
  });
  // Se o total for > 12, abre campo manual automaticamente
  const [showCustom, setShowCustom] = useState(() => {
    if (!row?.installment || row.installment === '-') return false;
    return (parseInt(row.installment.split('/')[1]) || 0) > 12;
  });

  // Extrai o DIA de fechamento do cartão (closeDate está em DD/MM/AAAA)
  const closingDay = parseInt((card.close_date || card.closeDate || '').split('/')[0]) || 1;
  const autoInstallment = computeCurrentInstallment(draft.date, totalInstallments, closingDay);

  // Override manual da parcela atual (null = usa o cálculo automático)
  const [installmentOverride, setInstallmentOverride] = useState(() => {
    if (!row?.installment || row.installment === '-') return null;
    const stored = parseInt(row.installment.split('/')[0]) || null;
    return stored;
  });
  // Ao mudar o total, garante que o override não ultrapasse o novo total
  const currentInstallment = installmentOverride !== null
    ? Math.min(installmentOverride, totalInstallments)
    : autoInstallment;

  return (
    <ModalShell title={title} onClose={onClose}>
      <form
        className="modal-form"
        onSubmit={(event) => {
          event.preventDefault();
          const installment = parcelado ? `${currentInstallment}/${totalInstallments}` : '-';
          onSave({ ...draft, installment });
        }}
      >
        <div className="form-grid two">
          <Field label="Descrição da compra" value={draft.description} onChange={(description) => setDraft({ ...draft, description })} />
          <CurrencyField label="Valor da compra" value={draft.amount} onChange={(v) => setDraft((d) => ({ ...d, amount: v }))} />
          <label className="field span-two"><span>Cartão</span><i><BankBadge bank={card.bank} /><input value={`${card.name}  •••• ${card.last4}`} readOnly /></i></label>
          <DatePickerField label="Data da compra" value={draft.date} onChange={(date) => setDraft({ ...draft, date })} />
        </div>

        <div className="installment-mode">
          <button className={!parcelado ? 'active' : ''} type="button" onClick={() => setParcelado(false)}><CreditCard size={18} />À vista</button>
          <button className={parcelado ? 'active' : ''} type="button" onClick={() => setParcelado(true)}><Clock3 size={18} />Parcelado</button>
        </div>

        {parcelado && (
          <div className="installment-pills-wrap">
            <span className="installment-pills-label">Número de parcelas</span>
            <div className="installment-pills">
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`pill-num${totalInstallments === n && !showCustom ? ' active' : ''}`}
                  onClick={() => { setTotalInstallments(n); setShowCustom(false); }}
                >
                  {n}
                </button>
              ))}
              {/* Pill "+" para mais de 12 parcelas */}
              <button
                type="button"
                className={`pill-num pill-plus${showCustom ? ' active' : ''}`}
                onClick={() => setShowCustom(true)}
              >
                +
              </button>
            </div>

            {showCustom && (
              <Field
                label="Total de parcelas"
                value={String(totalInstallments)}
                onChange={(v) => {
                  const n = parseInt(v.replace(/\D/g, ''));
                  if (!isNaN(n) && n > 0) setTotalInstallments(n);
                }}
              />
            )}

            {/* Seletor da parcela atual */}
            <div className="installment-current-block">
              <div className="installment-current-head">
                <span className="installment-pills-label">Qual parcela está sendo paga?</span>
                {installmentOverride !== null && (
                  <button type="button" className="installment-auto-reset"
                    onClick={() => setInstallmentOverride(null)}>
                    Usar automático
                  </button>
                )}
              </div>
              {totalInstallments <= 12 ? (
                <div className="installment-pills">
                  {Array.from({ length: totalInstallments }, (_, i) => i + 1).map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`pill-num${currentInstallment === n ? ' active' : ''}${n === autoInstallment && installmentOverride === null ? ' pill-auto' : ''}`}
                      onClick={() => setInstallmentOverride(n === autoInstallment ? null : n)}
                      title={n === autoInstallment ? 'Calculado automaticamente' : ''}
                    >{n}</button>
                  ))}
                </div>
              ) : (
                <div className="installment-stepper">
                  <button type="button" onClick={() => setInstallmentOverride(Math.max(1, currentInstallment - 1))}>−</button>
                  <span>{currentInstallment} <small>de {totalInstallments}</small></span>
                  <button type="button" onClick={() => setInstallmentOverride(Math.min(totalInstallments, currentInstallment + 1))}>+</button>
                </div>
              )}
              {installmentOverride === null && (
                <p className="installment-auto-note"><Info size={13} /> Calculada automaticamente pela data da compra</p>
              )}
            </div>
          </div>
        )}

        <label className="mine-switch">
          <input type="checkbox" checked={draft.mine} onChange={(event) => setDraft({ ...draft, mine: event.target.checked })} />
          Este item é meu
        </label>
        <div className="modal-actions">
          {onDelete && <button className="danger-link" type="button" onClick={() => onDelete(row.id)}><Trash2 size={18} />Excluir item</button>}
          <button className="ghost" type="button" onClick={onClose}>Cancelar</button>
          <button className="primary" type="submit">{row ? 'Salvar alterações' : 'Adicionar item'}</button>
        </div>
      </form>
    </ModalShell>
  );
}

function UploadModal({ card, uploading, progress, error, onClose, onUpload, referenceDateLabel }) {
  const [files, setFiles] = useState([]);
  const [mode, setMode] = useState('append');
  const fileLabel = files.length ? `${files.length} arquivo(s) selecionado(s)` : 'PDF, JPG, JPEG ou PNG';
  const closingDay = getCardClosingDay(card);
  return (
    <ModalShell title="Subir fatura" onClose={onClose}>
      <div className="upload-meta"><BankBadge bank={card.bank} />Cartão selecionado: {card.name} •••• {card.last4}</div>
      <div className="upload-meta"><CreditCard size={21} />Banco: {getBankName(card.bank)}</div>
      <div className="upload-meta"><CalendarDays size={21} />Mês de referência: {referenceDateLabel || getReferenceMonthLabel(closingDay)}</div>
      <label className="drop-zone">
        <CloudUpload size={54} />
        <strong>Selecione um PDF ou fotos da fatura</strong>
        <span>Arraste e solte o arquivo aqui ou clique para selecionar</span>
        <input type="file" multiple accept="application/pdf,image/jpeg,image/png" onChange={(event) => setFiles(Array.from(event.target.files || []))} />
        <div>
          <button type="button"><FileText size={19} />PDF</button>
          <button type="button">Fotos</button>
        </div>
        <small>{fileLabel}<br />Formatos aceitos: PDF, JPG, JPEG, PNG. Tamanho máximo: 20 MB por arquivo.</small>
      </label>

      <div className="upload-mode-toggle">
        <button
          type="button"
          className={`upload-mode-btn${mode === 'append' ? ' active' : ''}`}
          onClick={() => setMode('append')}
        >
          <PlusCircle size={16} /> Adicionar à fatura
        </button>
        <button
          type="button"
          className={`upload-mode-btn${mode === 'replace' ? ' active' : ''}`}
          onClick={() => setMode('replace')}
        >
          <RefreshCw size={16} /> Substituir importados
        </button>
      </div>
      <p className="upload-mode-hint">
        {mode === 'append'
          ? 'Os lançamentos do PDF serão somados aos que já estão na fatura.'
          : 'Os lançamentos importados anteriormente serão substituídos. Itens adicionados manualmente são preservados.'}
      </p>

      {progress && <div className="upload-progress">{progress}</div>}
      {error && <div className="upload-error">{error}</div>}
      <div className="modal-actions">
        <button className="ghost" type="button" onClick={onClose}>Cancelar</button>
        <button className="primary" type="button" disabled={uploading} onClick={() => onUpload(files, mode)}>
          {uploading ? 'Analisando...' : 'Processar fatura'} <ChevronRight size={22} />
        </button>
      </div>
    </ModalShell>
  );
}

function CloseInvoiceModal({ card, onClose, onConfirm }) {
  return (
    <ModalShell title="Encerrar fatura" onClose={onClose} dangerIcon={<CircleCheck size={36} />}>
      <p className="centered-text">
        A fatura do cartão <strong>{card?.name || 'selecionado'}</strong> venceu hoje.<br />
        <strong>Você já pagou essa fatura?</strong>
      </p>
      <div className="info-strip big">
        <Info size={20} />
        Ao encerrar, esta fatura será salva no histórico como fechada e as parcelas restantes continuarão como previsão nos próximos meses.
      </div>
      <div className="modal-actions">
        <button className="ghost" type="button" onClick={onClose}>Ainda não</button>
        <button className="primary" type="button" onClick={onConfirm || onClose}>Sim, marcar como paga</button>
      </div>
    </ModalShell>
  );
}

function DeleteCardModal({ card, onClose, onDelete }) {
  return (
    <ModalShell title="Excluir cartão" onClose={onClose} dangerIcon={<CircleAlert size={37} />}>
      <p className="centered-text">Excluir o cartão <strong>{card.name}</strong>? Todos os dados, faturas, histórico e previsões desse cartão serão apagados permanentemente.</p>
      <div className="modal-actions">
        <button className="ghost" type="button" onClick={onClose}>Cancelar</button>
        <button className="danger-button" type="button" onClick={onDelete}>Excluir definitivamente</button>
      </div>
    </ModalShell>
  );
}

function NotificationsModal({ values, onClose, onSave }) {
  const [draft, setDraft] = useState(values);
  return (
    <ModalShell title="Preferências de notificação" onClose={onClose}>
      <p className="muted">Escolha quais alertas deseja receber.</p>
      <NotificationPanel values={draft} onChange={setDraft} showHeader />
      <button className="primary full" type="button" onClick={() => onSave(draft)}>Salvar preferências</button>
    </ModalShell>
  );
}

// ─── Tela de loading ─────────────────────────────────────────
function LoadingScreen() {
  return (
    <div className="auth-screen">
      <div className="auth-logo"><Logo /></div>
      <p className="auth-loading">Carregando seus dados…</p>
    </div>
  );
}

// ─── Tela de Login / Cadastro ─────────────────────────────────
function AuthPage({ onAuth }) {
  const [mode, setMode] = useState('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setLoading(true); setError('');
    if (mode === 'signup') {
      const { data, error: err } = await db.signUp(email, password, name);
      if (err) { setError(err.message); setLoading(false); return; }
      if (data?.session) onAuth(data.session);
      else setError('Conta criada! Verifique seu e-mail para confirmar o cadastro.');
    } else {
      const { data, error: err } = await db.signIn(email, password);
      if (err) { setError(err.message); setLoading(false); return; }
      onAuth(data.session);
    }
    setLoading(false);
  }

  return (
    <div className="auth-screen">
      <div className="auth-logo"><Logo /></div>
      <section className="auth-card">
        <h1>{mode === 'signup' ? 'Criar conta' : 'Entrar na sua conta'}</h1>
        <form className="modal-form" onSubmit={handleSubmit}>
          {mode === 'signup' && <Field label="Seu nome" value={name} onChange={setName} />}
          <Field label="E-mail" value={email} onChange={setEmail} />
          <Field label="Senha" value={password} onChange={setPassword} type="password" />
          {error && <p className="auth-error">{error}</p>}
          <button className="primary wide" type="submit" disabled={loading}>
            {loading ? 'Aguarde…' : mode === 'signup' ? 'Criar conta' : 'Entrar'}
          </button>
        </form>
        <button className="auth-toggle" type="button" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); }}>
          {mode === 'signin' ? 'Não tem conta? Cadastre-se' : 'Já tem conta? Entrar'}
        </button>
      </section>
    </div>
  );
}

// ─── Root: gerencia sessão e decide o que renderizar ─────────
function Root() {
  const [session, setSession] = useState(undefined); // undefined = carregando

  useEffect(() => {
    db.getSession().then(({ data }) => setSession(data || null));
    const { data: { subscription } } = db.onAuthChange((s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  if (session === undefined) return <LoadingScreen />;
  if (!session) return <AuthPage onAuth={setSession} />;
  return <App session={session} />;
}

createRoot(document.getElementById('root')).render(<Root />);
