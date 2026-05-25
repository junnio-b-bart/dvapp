/**
 * db.js — Camada de acesso ao Supabase
 * Todas as funções retornam { data, error }
 */

import { supabase } from './supabase.js';

// ─── AUTH ────────────────────────────────────────────────────

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  return { data: data?.session, error };
}

export async function signUp(email, password, name) {
  return supabase.auth.signUp({
    email,
    password,
    options: { data: { name } },
  });
}

export async function signIn(email, password) {
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOut() {
  return supabase.auth.signOut();
}

export async function updatePassword(newPassword) {
  return supabase.auth.updateUser({ password: newPassword });
}

export async function updateUserInfo({ email, phone }) {
  const payload = {};
  if (email) payload.email = email;
  if (phone !== undefined) payload.data = { phone_number: phone };
  return supabase.auth.updateUser(payload);
}

export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange((_event, session) => callback(session));
}

// ─── PROFILE ─────────────────────────────────────────────────

export async function getProfile(userId) {
  return supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
}

export async function updateProfile(userId, fields) {
  return supabase
    .from('profiles')
    .update(fields)
    .eq('id', userId);
}

// ─── CARDS ───────────────────────────────────────────────────

export async function getCards(userId) {
  return supabase
    .from('cards')
    .select('*')
    .eq('user_id', userId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
}

export async function insertCard(userId, card) {
  return supabase
    .from('cards')
    .insert({
      user_id: userId,
      name: card.name,
      last4: card.last4,
      owner: card.owner || null,
      bank: card.bank || 'nubank',
      brand: card.brand || 'mastercard',
      close_date: card.closeDate || null,
      due_date: card.dueDate || null,
      position: card.position || 0,
    })
    .select()
    .single();
}

export async function updateCard(cardId, userId, fields) {
  const mapped = {};
  if (fields.name !== undefined)      mapped.name = fields.name;
  if (fields.last4 !== undefined)     mapped.last4 = fields.last4;
  if (fields.owner !== undefined)     mapped.owner = fields.owner;
  if (fields.bank !== undefined)      mapped.bank = fields.bank;
  if (fields.brand !== undefined)     mapped.brand = fields.brand;
  if (fields.closeDate !== undefined) mapped.close_date = fields.closeDate;
  if (fields.dueDate !== undefined)   mapped.due_date = fields.dueDate;

  return supabase
    .from('cards')
    .update(mapped)
    .eq('id', cardId)
    .eq('user_id', userId);
}

export async function deleteCard(cardId, userId) {
  return supabase
    .from('cards')
    .delete()
    .eq('id', cardId)
    .eq('user_id', userId);
}

// ─── INVOICES ────────────────────────────────────────────────

export async function getOrCreateInvoice(cardId, userId, month, year) {
  // Tenta buscar a fatura existente
  const { data: existing, error: fetchError } = await supabase
    .from('invoices')
    .select('*')
    .eq('card_id', cardId)
    .eq('month', month)
    .eq('year', year)
    .maybeSingle();

  if (fetchError) return { data: null, error: fetchError };
  if (existing) return { data: existing, error: null };

  // Cria se não existir
  return supabase
    .from('invoices')
    .insert({ card_id: cardId, user_id: userId, month, year, status: 'open' })
    .select()
    .single();
}

export async function getInvoicesByCard(cardId) {
  return supabase
    .from('invoices')
    .select('*')
    .eq('card_id', cardId)
    .order('year', { ascending: false })
    .order('month', { ascending: false });
}

export async function closeInvoice(invoiceId, userId) {
  return supabase
    .from('invoices')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('user_id', userId);
}

// ─── INVOICE ITEMS ───────────────────────────────────────────

export async function getItemsByInvoice(invoiceId) {
  return supabase
    .from('invoice_items')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('date', { ascending: true });
}

export async function getItemsByCard(cardId) {
  return supabase
    .from('invoice_items')
    .select('*')
    .eq('card_id', cardId)
    .order('date', { ascending: true });
}

export async function insertItems(items) {
  // items é um array de objetos já mapeados para o formato do banco
  return supabase
    .from('invoice_items')
    .insert(items)
    .select();
}

export async function insertItem(invoiceId, cardId, userId, item) {
  return supabase
    .from('invoice_items')
    .insert({
      invoice_id: invoiceId,
      card_id: cardId,
      user_id: userId,
      date: item.date,
      description: item.description,
      installment: item.installment || '-',
      amount: Number(item.amount) || 0,
      mine: Boolean(item.mine),
      manual: Boolean(item.manual),
    })
    .select()
    .single();
}

export async function updateItem(itemId, userId, fields) {
  const mapped = {};
  if (fields.date !== undefined)        mapped.date = fields.date;
  if (fields.description !== undefined) mapped.description = fields.description;
  if (fields.installment !== undefined) mapped.installment = fields.installment;
  if (fields.amount !== undefined)      mapped.amount = Number(fields.amount) || 0;
  if (fields.mine !== undefined)        mapped.mine = Boolean(fields.mine);
  if (fields.manual !== undefined)      mapped.manual = Boolean(fields.manual);

  return supabase
    .from('invoice_items')
    .update(mapped)
    .eq('id', itemId)
    .eq('user_id', userId);
}

export async function deleteItem(itemId, userId) {
  return supabase
    .from('invoice_items')
    .delete()
    .eq('id', itemId)
    .eq('user_id', userId);
}

export async function replaceInvoiceItems(invoiceId, cardId, userId, items) {
  // Remove todos os itens existentes e insere os novos (usado no upload de fatura)
  const { error: delError } = await supabase
    .from('invoice_items')
    .delete()
    .eq('invoice_id', invoiceId)
    .eq('manual', false);      // preserva os inseridos manualmente

  if (delError) return { data: null, error: delError };

  if (!items.length) return { data: [], error: null };

  const rows = items.map((item) => ({
    invoice_id: invoiceId,
    card_id: cardId,
    user_id: userId,
    date: item.date,
    description: item.description,
    installment: item.installment || '-',
    amount: Number(item.amount) || 0,
    mine: Boolean(item.mine),
    manual: false,
  }));

  return supabase.from('invoice_items').insert(rows).select();
}

// ─── NOTIFICATION SETTINGS ───────────────────────────────────

export async function getNotificationSettings(userId) {
  return supabase
    .from('notification_settings')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
}

export async function upsertNotificationSettings(userId, values) {
  return supabase
    .from('notification_settings')
    .upsert({ user_id: userId, ...values, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
}

// ─── STORAGE (PDFs / imagens de fatura) ──────────────────────

export async function uploadInvoiceFile(userId, cardId, file) {
  const ext = file.name.split('.').pop();
  const path = `${userId}/${cardId}/${Date.now()}.${ext}`;

  const { data, error } = await supabase.storage
    .from('invoices')
    .upload(path, file, { upsert: false });

  return { data, error, path };
}

export async function getInvoiceFileUrl(path) {
  return supabase.storage.from('invoices').createSignedUrl(path, 3600); // 1h
}
