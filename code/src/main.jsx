import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Bell,
  CalendarDays,
  Check,
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
  Menu,
  Pencil,
  Plus,
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

// Normaliza um card do formato Supabase (snake_case) para o formato do app (camelCase)
function normalizeCard(card) {
  return {
    id: card.id,
    name: card.name,
    last4: card.last4,
    owner: card.owner || '',
    bank: card.bank || 'nubank',
    brand: card.brand || 'mastercard',
    closeDate: card.close_date || '',
    dueDate: card.due_date || '',
    position: card.position || 0,
  };
}

function getCurrentMonthYear() {
  const now = new Date();
  return { month: now.getMonth() + 1, year: now.getFullYear() };
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

function getReferenceDateParts() {
  const now = new Date();
  return { monthIndex: now.getMonth(), year: now.getFullYear() };
}

function getReferenceMonthLabel() {
  const { monthIndex, year } = getReferenceDateParts();
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
    notifications: { closing: true, due: true, forecast: true, upload: true, overdue: true },
    profileName: '',   // nome do usuário no app (profiles.name)
    theme: localStorage.getItem('app-theme') || 'ocean',
  });
  const [modal, setModal] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [uploadProgress, setUploadProgress] = useState('');

  const selectedCard = state.cards.find((c) => c.id === state.selectedCardId) || state.cards[0];
  const currentItems = state.itemsByCard[selectedCard?.id] || [];
  const visibleItems = currentItems.filter((row) => row.description.toLowerCase().includes(state.search.toLowerCase()));
  const myItems = currentItems.filter((row) => row.mine);
  const totals = useMemo(() => ({
    all: currentItems.reduce((sum, row) => sum + Number(row.amount), 0),
    mine: myItems.reduce((sum, row) => sum + Number(row.amount), 0),
    mineCount: myItems.length,
    allCount: currentItems.length,
  }), [currentItems, myItems]);

  // ── Carga inicial dos dados ───────────────────────────────────
  useEffect(() => {
    async function load() {
      const { data: cards } = await db.getCards(userId);
      if (!cards?.length) { setAppLoading(false); return; }

      const normalized = cards.map(normalizeCard);
      const firstId = normalized[0].id;
      const { month, year } = getCurrentMonthYear();

      const { data: inv } = await db.getOrCreateInvoice(firstId, userId, month, year);
      const { data: items } = inv ? await db.getItemsByInvoice(inv.id) : { data: [] };
      const [{ data: notifs }, { data: profile }] = await Promise.all([
        db.getNotificationSettings(userId),
        db.getProfile(userId),
      ]);

      setState((prev) => ({
        ...prev,
        cards: normalized,
        selectedCardId: firstId,
        itemsByCard: { [firstId]: items || [] },
        invoiceIdByCard: inv ? { [firstId]: inv.id } : {},
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
    root.classList.remove('theme-orange', 'theme-amber');
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
      const { month, year } = getCurrentMonthYear();
      const { data: inv } = await db.getOrCreateInvoice(id, userId, month, year);
      const { data: items } = inv ? await db.getItemsByInvoice(inv.id) : { data: [] };
      setState((prev) => ({
        ...prev,
        itemsByCard: { ...prev.itemsByCard, [id]: items || [] },
        invoiceIdByCard: { ...prev.invoiceIdByCard, ...(inv ? { [id]: inv.id } : {}) },
      }));
    }
  }

  function updateCardItems(items) {
    setState((prev) => ({ ...prev, itemsByCard: { ...prev.itemsByCard, [selectedCard.id]: items } }));
  }

  async function toggleMine(id) {
    const row = currentItems.find((r) => r.id === id);
    if (!row) return;
    const next = !row.mine;
    updateCardItems(currentItems.map((r) => r.id === id ? { ...r, mine: next } : r));
    await db.updateItem(id, userId, { mine: next });
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
      let invoiceId = state.invoiceIdByCard[selectedCard.id];
      if (!invoiceId) {
        const { month, year } = getCurrentMonthYear();
        const { data: inv } = await db.getOrCreateInvoice(selectedCard.id, userId, month, year);
        invoiceId = inv?.id;
        if (invoiceId) setState((prev) => ({ ...prev, invoiceIdByCard: { ...prev.invoiceIdByCard, [selectedCard.id]: invoiceId } }));
      }
      if (invoiceId) {
        const { data: saved } = await db.insertItem(invoiceId, selectedCard.id, userId, normalized);
        const withId = saved ? { ...normalized, id: saved.id } : { ...normalized, id: `m-${Date.now()}` };
        updateCardItems([withId, ...currentItems]);
      } else {
        updateCardItems([normalized, ...currentItems]);
      }
    }
    setModal(null);
  }

  async function removeItem(id) {
    updateCardItems(currentItems.filter((row) => row.id !== id));
    await db.deleteItem(id, userId);
    setModal(null);
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

  async function processUpload(files) {
    if (!files.length) { setUploadError('Selecione um PDF ou imagens da fatura.'); return; }
    setUploading(true); setUploadError(''); setUploadProgress('Preparando arquivos...');
    try {
      const pdfFiles = files.filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
      const imageFiles = files.filter((file) => String(file.type || '').startsWith('image/'));
      const { monthIndex, year } = getReferenceDateParts();
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
      const { month, year: yr } = getCurrentMonthYear();
      let invoiceId = state.invoiceIdByCard[selectedCard.id];
      if (!invoiceId) {
        const { data: inv } = await db.getOrCreateInvoice(selectedCard.id, userId, month, yr);
        invoiceId = inv?.id;
      }
      if (invoiceId) {
        await db.replaceInvoiceItems(invoiceId, selectedCard.id, userId, nextItems);
        for (const file of files) await db.uploadInvoiceFile(userId, selectedCard.id, file);
      }

      setState((prev) => ({
        ...prev,
        activeTab: 'faturas',
        itemsByCard: { ...prev.itemsByCard, [selectedCard.id]: nextItems },
        invoiceIdByCard: { ...prev.invoiceIdByCard, ...(invoiceId ? { [selectedCard.id]: invoiceId } : {}) },
      }));
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

  if (appLoading) return <LoadingScreen />;

  // Avatar usa o nome do perfil; fallback para o titular do cartão selecionado
  const ownerInitials = getInitials(state.profileName) || getInitials(selectedCard?.owner);

  return (
    <div className="app-shell">
      <Topbar
        activeTab={state.activeTab}
        badge={state.notificationBadge}
        ownerInitials={ownerInitials}
        onTab={setTab}
        onMenu={() => update({ drawerOpen: true })}
        onNotifications={() => setModal('notifications')}
        onSignOut={db.signOut}
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
                  items={visibleItems}
                  totals={totals}
                  search={state.search}
                  onSearch={(search) => update({ search })}
                  onToggle={toggleMine}
                  onUpload={() => setModal('upload')}
                  onAdd={() => setModal('add-item')}
                  onEdit={(row) => setModal({ type: 'edit-item', row })}
                  onSave={() => setTab('carteira')}
                />
              )}
              {state.activeTab === 'historico' && <HistoryPage items={myItems} totals={totals} onUpload={() => setModal('upload')} />}
              {state.activeTab === 'ajustes' && (
                <SettingsPage
                  card={selectedCard}
                  profileName={state.profileName}
                  notifications={state.notifications}
                  theme={state.theme}
                  onTheme={(theme) => update({ theme })}
                  onChangeCard={updateCard}
                  onSaveProfile={async (name) => {
                    update({ profileName: name });
                    await db.updateProfile(userId, { name });
                  }}
                  onNotifications={(notifications) => update({ notifications })}
                  onSaveNotifications={(notifications) => db.upsertNotificationSettings(userId, notifications)}
                  onDelete={() => setModal('delete-card')}
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
    </div>
  );
}

// FIX: Recebe ownerInitials e exibe dinamicamente no avatar
function Topbar({ activeTab, badge, ownerInitials, onTab, onMenu, onNotifications }) {
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
        <button className="bell-button" type="button" onClick={onNotifications} aria-label="Notificações">
          <Bell size={24} />
          {badge > 0 && <span>{badge}</span>}
        </button>
        <button className="avatar-button" type="button">{ownerInitials}</button>
        <ChevronDown className="desktop-only" size={20} />
      </div>
    </header>
  );
}

function Logo() {
  return (
    <button className="logo" type="button" aria-label="DivideConta">
      <img src="/logofull.png" alt="DivideConta" className="logo-full-img" />
      <img src="/logoicon.png" alt="DivideConta" className="logo-icon-img" />
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

function InvoicesPage({ items, totals, search, onSearch, onToggle, onUpload, onAdd, onEdit, onSave }) {
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
      <SectionTitle title="Fatura completa" />
      <CleanTable mode="invoice" items={items} onToggle={onToggle} onEdit={onEdit} />
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
    </div>
  );
}

function HistoryPage({ items, totals, onUpload }) {
  const monthNamesShort = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
  const monthNamesFull = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
  const { monthIndex: currentMonthIndex, year: currentYear } = getReferenceDateParts();
  const [selectedMonthIndex, setSelectedMonthIndex] = useState(currentMonthIndex);
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [yearOpen, setYearOpen] = useState(false);
  const stripRef = useRef(null);
  const stripFirstRender = useRef(true);

  const monthDiff = (selectedYear - currentYear) * 12 + (selectedMonthIndex - currentMonthIndex);
  const isCurrentMonth = monthDiff === 0;

  const displayItems = useMemo(() => {
    if (monthDiff === 0) return items;
    if (monthDiff > 0) return getForecastItems(items, monthDiff);
    return [];
  }, [items, monthDiff]);

  const displayTotal = useMemo(() => displayItems.reduce((s, i) => s + i.amount, 0), [displayItems]);

  function getMonthStatus(index, year) {
    const diff = (year - currentYear) * 12 + (index - currentMonthIndex);
    if (diff < 0) return 'closed';
    if (diff === 0) return 'current';
    return getForecastItems(items, diff).length > 0 ? 'forecast' : 'empty';
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
  const nextMonthIndex = (selectedMonthIndex + 1) % 12;
  const nextMonthYear = selectedMonthIndex === 11 ? selectedYear + 1 : selectedYear;
  const nextMonthForecast = getForecastItems(items, monthDiff + 1);
  const isPastEmpty = monthDiff < 0 && displayItems.length === 0;

  return (
    <div className="page-stack history-stack">

      {/* ── Métricas fora do flex container — mesmo contexto que Carteira ── */}
      <section className="metric-grid wallet-grid">
        <Metric
          icon={FileText}
          title="Minha parte"
          value={monthDiff < 0 ? 'R$ 0,00' : money(isCurrentMonth ? totals.mine : displayTotal)}
        />
        <Metric
          icon={List}
          title="Lançamentos"
          value={monthDiff < 0 ? '—' : String(displayItems.length)}
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
                  {[currentYear - 2, currentYear - 1, currentYear, currentYear + 1].map((y) => (
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
            <button className="ghost small" type="button">
              <Download size={16} />Exportar PDF
            </button>
          </div>

          <h3 className="history-items-title">Itens da minha fatura</h3>

          {isPastEmpty ? (
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

const THEMES = [
  { id: 'ocean',  label: 'Azul oceano' },
  { id: 'orange', label: 'Laranja'     },
  { id: 'amber',  label: 'Âmbar'       },
];

function SettingsPage({ card, profileName, notifications, theme = 'ocean', onTheme, onChangeCard, onSaveProfile, onNotifications, onSaveNotifications, onDelete }) {
  const [draft, setDraft] = useState(card);
  const [profileDraft, setProfileDraft] = useState(profileName || '');
  const [saveStatus, setSaveStatus] = useState('idle'); // 'idle' | 'saving' | 'saved'
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

      {/* ── Ajustes do app ── (primeiro, expandido por padrão) */}
      <CollapsibleCard title="Ajustes do app" subtitle="Personalize sua experiência no DivideConta." defaultOpen={true}>
        <Field
          label="Seu nome no app"
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
          <Field label="Data de fechamento" icon={CalendarDays} value={draft.closeDate} onChange={(closeDate) => updateDraft({ closeDate })} />
          <Field label="Data de vencimento no" icon={CalendarDays} value={draft.dueDate} onChange={(dueDate) => updateDraft({ dueDate })} />
        </div>
        <BankChips value={draft.bank} onChange={(bank) => updateDraft({ bank })} />
        <BrandChips value={draft.brand} onChange={(brand) => updateDraft({ brand })} />
        <div className="settings-actions">
          <button className="danger-link" type="button" onClick={onDelete}><Trash2 size={18} />Excluir cartão</button>
        </div>
      </CollapsibleCard>

      {/* ── Notificações ── */}
      <CollapsibleCard title="Notificações" subtitle="Gerencie os alertas que você deseja receber." defaultOpen={false}>
        <NotificationPanel values={notifications} onChange={handleNotifChange} />
      </CollapsibleCard>
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

function CleanTable({ items, mode, compact, onToggle, onEdit }) {
  // ── Ordenação por coluna ───────────────────────────────────────
  // sortKey: null | 'date' | 'description' | 'installment' | 'amount'
  // sortDir: 'asc' | 'desc'
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

  // Indicador visual: ⇅ quando inativo, ▴/▾ quando ativo
  function SortIcon({ colKey }) {
    if (sortKey !== colKey) return <span className="sort-off">⇅</span>;
    return <span className="sort-on">{sortDir === 'asc' ? '▴' : '▾'}</span>;
  }

  const sorted = useMemo(() => {
    if (!sortKey) return items;
    return [...items].sort((a, b) => {
      let v = 0;
      if (sortKey === 'date') {
        // Parseia "DD/MM/YYYY" ou "DD/MM" → número comparável
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
        // Ordena pelo TOTAL de parcelas (número depois da "/")
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

  return (
    <section className={`table-card ${compact ? 'compact' : ''}`}>
      <div className={`table-header ${mode}`}>
        {mode === 'invoice' && <span />}
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
        {mode === 'invoice' && <span>Ações</span>}
      </div>
      {items.length === 0 && (
        <div className="table-empty">
          <FileText size={32} />
          <p>Nenhum item ainda. Suba uma fatura ou adicione manualmente.</p>
        </div>
      )}
      {sorted.map((row) => (
        <div className={`table-line ${mode} ${row.mine ? 'selected' : ''}`} key={row.id}>
          {mode === 'invoice' && <button className="check-cell" type="button" onClick={() => onToggle(row.id)}>{row.mine && <Check size={15} />}</button>}
          <span className="date-cell" data-short={(row.date || '').slice(0, 5)}>{row.date}</span>
          <strong>{row.description}{row.manual && <em>Manual</em>}</strong>
          <span>{row.installment}</span>
          <b>{amountOnly(row.amount)}</b>
          {mode === 'invoice' && <button className="edit-button" type="button" onClick={() => onEdit(row)} aria-label="Editar item"><Pencil size={18} /></button>}
        </div>
      ))}
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
          <Field label="Data de fechamento" icon={CalendarDays} value={draft.closeDate} onChange={(closeDate) => setDraft({ ...draft, closeDate })} />
          <Field label="Data de vencimento" icon={CalendarDays} value={draft.dueDate} onChange={(dueDate) => setDraft({ ...draft, dueDate })} />
        </div>
        <BankChips value={draft.bank} onChange={(bank) => setDraft({ ...draft, bank })} />
        <BrandChips value={draft.brand} onChange={(brand) => setDraft({ ...draft, brand })} />
        <div className="modal-actions"><button className="ghost" type="button" onClick={onClose}>Cancelar</button><button className="primary" type="submit">Salvar cartão</button></div>
      </form>
    </ModalShell>
  );
}

// Calcula a parcela atual com base na diferença de meses entre a data da compra e hoje
function computeCurrentInstallment(dateStr, total) {
  if (!dateStr || !total) return 1;
  const parts = dateStr.split('/');
  if (parts.length !== 3) return 1;
  const purchase = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
  const today = new Date();
  const elapsed = (today.getFullYear() - purchase.getFullYear()) * 12
    + (today.getMonth() - purchase.getMonth());
  return Math.min(Math.max(1, elapsed + 1), total);
}

// FIX: ItemModal usa data de hoje e descrição vazia para novos itens
function ItemModal({ title, card, row, onClose, onSave, onDelete }) {
  const [parcelado, setParcelado] = useState(row?.installment && row.installment !== '-');
  const [draft, setDraft] = useState(row || item(`m-${Date.now()}`, getTodayFormatted(), '', '-', 0, true, true));

  // Estado de texto separado para o campo Valor — evita NaN ao reeditar valor formatado
  const [amountText, setAmountText] = useState(() =>
    row?.amount && Number(row.amount) !== 0 ? amountOnly(row.amount) : ''
  );

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

  function handleAmountChange(raw) {
    setAmountText(raw);
    // Aceita "75,50" | "75.50" | "1.624,03" (formato BR com separador de milhar)
    const c = raw.replace(/[^\d,.]/g, '');
    let n;
    if (c.includes('.') && c.includes(',')) {
      // formato BR completo: ponto = milhar, vírgula = decimal
      n = parseFloat(c.replace(/\./g, '').replace(',', '.'));
    } else {
      n = parseFloat(c.replace(',', '.'));
    }
    setDraft((prev) => ({ ...prev, amount: isNaN(n) ? 0 : n }));
  }

  const currentInstallment = computeCurrentInstallment(draft.date, totalInstallments);

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
          <Field label="Valor da compra" value={amountText} onChange={handleAmountChange} />
          <label className="field span-two"><span>Cartão</span><i><BankBadge bank={card.bank} /><input value={`${card.name}  •••• ${card.last4}`} readOnly /></i></label>
          <Field label="Data da compra" icon={CalendarDays} value={draft.date} onChange={(date) => setDraft({ ...draft, date })} />
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

            {/* Prévia da parcela calculada automaticamente */}
            <div className="info-strip">
              <Info size={17} />
              Parcela atual calculada automaticamente: <strong>{currentInstallment} de {totalInstallments}</strong>
            </div>
          </div>
        )}

        {row && (
          <label className="mine-switch">
            <input type="checkbox" checked={draft.mine} onChange={(event) => setDraft({ ...draft, mine: event.target.checked })} />
            Este item é meu
          </label>
        )}
        <div className="modal-actions">
          {onDelete && <button className="danger-link" type="button" onClick={() => onDelete(row.id)}><Trash2 size={18} />Excluir item</button>}
          <button className="ghost" type="button" onClick={onClose}>Cancelar</button>
          <button className="primary" type="submit">{row ? 'Salvar alterações' : 'Adicionar item'}</button>
        </div>
      </form>
    </ModalShell>
  );
}

function UploadModal({ card, uploading, progress, error, onClose, onUpload }) {
  const [files, setFiles] = useState([]);
  const fileLabel = files.length ? `${files.length} arquivo(s) selecionado(s)` : 'PDF, JPG, JPEG ou PNG';
  return (
    <ModalShell title="Subir fatura" onClose={onClose}>
      <div className="upload-meta"><BankBadge bank={card.bank} />Cartão selecionado: {card.name} •••• {card.last4}</div>
      <div className="upload-meta"><CreditCard size={21} />Banco: {getBankName(card.bank)}</div>
      <div className="upload-meta"><CalendarDays size={21} />Mês de referência: {getReferenceMonthLabel()}</div>
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
      {progress && <div className="upload-progress">{progress}</div>}
      {error && <div className="upload-error">{error}</div>}
      <div className="modal-actions">
        <button className="ghost" type="button" onClick={onClose}>Cancelar</button>
        <button className="primary" type="button" disabled={uploading} onClick={() => onUpload(files)}>
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
