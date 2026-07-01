import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from './services/supabase';

const CACHE_KEY = "rack_cache_v2";
const MAX_SLOT = 3;
const RAK_A = ["A1", "A2", "A3", "A4", "A5"];
const RAK_B = ["B1", "B2", "B3", "B4", "B5"];
const RAK_C = ["C1", "C2", "C3", "C4", "C5"];
const RAK_LANTAI = ["L1", "L2"];

function splitNames(csv) {
  return String(csv || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function isLantaiSlot(slot) {
  return slot.startsWith("L");
}

export default function RakEdiWeb() {
  const [rack, setRack] = useState({});
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const [modalAdd, setModalAdd] = useState(false);
  const [addSlot, setAddSlot] = useState("");
  const [addName, setAddName] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [activeTransactions, setActiveTransactions] = useState([]);
  const [filteredSuggestions, setFilteredSuggestions] = useState([]);

  const [modalAction, setModalAction] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState("");
  const [selectedToken, setSelectedToken] = useState("");

  const [payModalVisible, setPayModalVisible] = useState(false);
  const [txToPay, setTxToPay] = useState(null);
  const [amountPaid, setAmountPaid] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [payLoading, setPayLoading] = useState(false);

  // TODO: belum ada logika untuk field ini (hanya UI, sesuai screenshot)
  const [deleteNameInput, setDeleteNameInput] = useState("");

  const loadRack = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('racks')
        .select('slot, names');

      if (error) throw error;

      const map = {};
      if (data) {
        data.forEach(row => {
          map[row.slot] = row.names || "";
        });
        setRack(map);
        localStorage.setItem(CACHE_KEY, JSON.stringify(map));
      }

      const { data: txData, error: txError } = await supabase
        .from('transactions')
        .select('*')
        .not('status', 'eq', 'Diambil')
        .not('payment_status', 'eq', 'Void');

      if (!txError && txData) {
        setActiveTransactions(txData);
      }

    } catch (error) {
      console.error("Gagal sinkronisasi Rak:", error.message);
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) setRack(JSON.parse(raw));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadRack(); }, [loadRack]);

  useEffect(() => {
    const query = addName.trim().toLowerCase();
    if (!query) {
      setFilteredSuggestions([]);
      return;
    }
    const filtered = activeTransactions.filter(tx =>
      (tx.customer_name && tx.customer_name.toLowerCase().includes(query)) ||
      (tx.receipt_number && tx.receipt_number.toLowerCase().includes(query))
    );
    setFilteredSuggestions(filtered);
  }, [addName, activeTransactions]);

  const qLow = useMemo(() => searchQuery.trim().toLowerCase(), [searchQuery]);

  function slotVisible(slot) {
    if (!qLow) return true;
    const csv = rack[slot] || "";
    return `${slot} ${csv}`.toLowerCase().includes(qLow);
  }

  const totalSepatu = useMemo(() => {
    let count = 0;
    Object.values(rack).forEach(csv => {
      count += splitNames(csv).length;
    });
    return count;
  }, [rack]);

  async function handleAddNama() {
    const sl = addSlot.trim().toUpperCase();
    const nm = addName.trim().toUpperCase();
    if (!sl || !nm) return alert("Data input belum lengkap.");

    const existing = splitNames(rack[sl] || "");
    if (!isLantaiSlot(sl) && existing.length >= MAX_SLOT) {
      return alert(`Slot ${sl} sudah penuh (${MAX_SLOT} nama).`);
    }

    setAddLoading(true);
    try {
      const newCsv = [...existing, nm].join(",");
      const { error } = await supabase
        .from('racks')
        .update({ names: newCsv, updated_at: new Date().toISOString() })
        .eq('slot', sl);
      if (error) throw error;

      const newRack = { ...rack, [sl]: newCsv };
      setRack(newRack);
      localStorage.setItem(CACHE_KEY, JSON.stringify(newRack));
      setModalAdd(false);
      setAddName("");
      loadRack();
    } catch (e) {
      alert("Error Database: " + e?.message);
    } finally {
      setAddLoading(false);
    }
  }

  async function handlePureDelete() {
    setLoading(true);
    try {
      const existing = splitNames(rack[selectedSlot] || "");
      const idx = existing.findIndex((x) => x.toUpperCase() === selectedToken.toUpperCase());
      if (idx >= 0) existing.splice(idx, 1);

      const newCsv = existing.join(",");
      const { error } = await supabase
        .from('racks')
        .update({ names: newCsv, updated_at: new Date().toISOString() })
        .eq('slot', selectedSlot);
      if (error) throw error;

      const newRack = { ...rack, [selectedSlot]: newCsv };
      setRack(newRack);
      localStorage.setItem(CACHE_KEY, JSON.stringify(newRack));
      setModalAction(false);
      alert("Nama berhasil dihapus dari slot rak.");
    } catch (e) {
      alert("Error Database: " + e?.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleAmbilBarang() {
    setModalAction(false);
    const currentToken = selectedToken;
    const currentSlot = selectedSlot;

    if (!currentToken.includes('#')) {
      setSelectedSlot(currentSlot);
      setSelectedToken(currentToken);
      return handleExecuteAmbilWorkflow();
    }

    const receiptNumber = currentToken.split('#')[1];
    setLoading(true);
    try {
      const { data: tx, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('receipt_number', receiptNumber)
        .maybeSingle();
      if (error) throw error;
      if (!tx) {
        alert("Data transaksi pembawa nomor nota ini tidak ditemukan.");
        return;
      }

      if (tx.payment_status === 'Lunas') {
        await handleExecuteAmbilWorkflow(tx);
      } else {
        setTxToPay(tx);
        setAmountPaid((tx.debt_amount || 0).toString());
        setPaymentMethod('Cash');
        setPayModalVisible(true);
      }
    } catch (e) {
      alert("Error: " + e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleProcessPelunasanInstan() {
    if (!txToPay) return;
    const inputNominal = parseInt(amountPaid) || 0;
    if (inputNominal <= 0) return alert('Masukkan nominal pelunasan kasir yang valid.');

    setPayLoading(true);
    try {
      const currentDebt = txToPay.debt_amount || 0;
      const currentPaid = txToPay.paid_amount || 0;
      const newPaidAmount = currentPaid + inputNominal;
      const newDebtAmount = Math.max(0, currentDebt - inputNominal);
      const newStatus = newDebtAmount === 0 ? 'Lunas' : 'Belum Lunas';

      const { error: txError } = await supabase
        .from('transactions')
        .update({
          paid_amount: newPaidAmount,
          amount_paid: newPaidAmount,
          debt_amount: newDebtAmount,
          payment_status: newStatus,
          payment_method: paymentMethod
        })
        .eq('id', txToPay.id);
      if (txError) throw txError;

      if (paymentMethod === 'Cash') {
        const { data: activeSession } = await supabase
          .from('cash_sessions')
          .select('id')
          .eq('status', 'OPEN')
          .maybeSingle();
        if (activeSession) {
          await supabase.from('cash_flows').insert([{
            session_id: activeSession.id,
            type: 'SETORAN',
            amount: inputNominal,
            description: `Pelunasan Piutang via Rak Edi #${txToPay.receipt_number}`
          }]);
        }
      }

      setPayModalVisible(false);
      await handleExecuteAmbilWorkflow(txToPay);
      alert('Pembayaran tersinkron dengan Cash Drawer & Nota Diarsipkan! 🎉');
    } catch (e) {
      alert("Error Pelunasan Instan: " + e.message);
    } finally {
      setPayLoading(false);
    }
  }

  async function handleExecuteAmbilWorkflow(tx) {
    try {
      const Tumor = splitNames(rack[selectedSlot] || "");
      const idx = Tumor.findIndex((x) => x.toUpperCase() === selectedToken.toUpperCase());
      if (idx >= 0) Tumor.splice(idx, 1);
      const newCsv = Tumor.join(",");
      const { error: rackError } = await supabase
        .from('racks')
        .update({ names: newCsv, updated_at: new Date().toISOString() })
        .eq('slot', selectedSlot);
      if (rackError) throw rackError;

      if (tx) {
        const { error: txError } = await supabase
          .from('transactions')
          .update({ status: 'Diambil' })
          .eq('id', tx.id);
        if (txError) throw txError;
      }

      const newRack = { ...rack, [selectedSlot]: newCsv };
      setRack(newRack);
      localStorage.setItem(CACHE_KEY, JSON.stringify(newRack));
      loadRack();
      if (!tx) alert("Barang non-nota dikeluarkan dari rak.");
    } catch (e) {
      alert("Error Pemrosesan Ambil: " + e.message);
    }
  }

  // ================= UI (restyled to match screenshot) =================

  function renderSlotCard(slot, isLantai = false) {
    if (!slotVisible(slot)) return null;
    const names = splitNames(rack[slot] || "");
    const isFull = !isLantai && names.length >= MAX_SLOT;
    const isHighlight = qLow && `${slot} ${rack[slot]}`.toLowerCase().includes(qLow);

    return (
      <div
        key={slot}
        className={`pb-3 mb-1 ${isHighlight ? 'bg-yellow-50 -mx-2 px-2 rounded-lg ring-2 ring-yellow-400' : ''}`}
      >
        <div className="text-[15px] font-bold text-slate-900 mb-1.5">{slot}</div>

        <div className="flex flex-col gap-1.5 mb-1.5">
          {names.map((nm, idx) => {
            const displayName = nm.split('#')[0];
            return (
              <div
                key={idx}
                className="flex justify-between items-center bg-[#dce9f5] rounded-md px-2.5 py-1.5"
              >
                <span className="text-[13px] text-slate-900 font-semibold truncate flex-1 pr-2">
                  {displayName}
                </span>
                <button
                  className="text-slate-800 hover:text-black font-bold text-sm px-1"
                  onClick={() => {
                    setSelectedSlot(slot);
                    setSelectedToken(nm);
                    setModalAction(true);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>

        {(!isFull || isLantai) && (
          <>
            <input
              className="w-full border border-slate-300 rounded-md px-2.5 py-1.5 text-[13px] text-slate-700 outline-none mb-1.5 placeholder:text-slate-400"
              placeholder="Nama baru"
              value={addSlot === slot ? addName : ""}
              onFocus={() => { setAddSlot(slot); }}
              onChange={(e) => { setAddSlot(slot); setAddName(e.target.value); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setAddSlot(slot);
                  setModalAdd(false);
                  handleAddNama();
                }
              }}
            />
            {addSlot === slot && filteredSuggestions.length > 0 && (
              <div className="mb-1.5 max-h-[110px] overflow-y-auto border border-slate-200 rounded-md bg-white shadow-md">
                {filteredSuggestions.map((tx) => (
                  <div
                    key={tx.id}
                    className="p-2 text-xs font-semibold text-blue-900 border-b border-slate-50 hover:bg-slate-50 cursor-pointer"
                    onClick={() => setAddName(`${tx.customer_name}#${tx.receipt_number}`)}
                  >
                    {tx.customer_name} ({tx.receipt_number})
                  </div>
                ))}
              </div>
            )}
            <button
              className="w-full bg-[#f4c430] hover:bg-[#e0b420] text-slate-900 text-[13px] font-bold py-1.5 rounded-md transition-colors"
              onClick={() => { setAddSlot(slot); handleAddNama(); }}
              disabled={addLoading && addSlot === slot}
            >
              {addLoading && addSlot === slot ? '...' : 'Tambah'}
            </button>
          </>
        )}
      </div>
    );
  }

  function renderBoardColumn(title, slots) {
    return (
      <div className="bg-white rounded-xl shadow-md p-4 flex-1 min-w-[220px]">
        <h2 className="text-base font-bold text-slate-900 text-center mb-3">{title}</h2>
        <div>
          {slots.map((sl) => renderSlotCard(sl, false))}
        </div>
      </div>
    );
  }

  function renderLantaiColumn() {
    return (
      <div className="bg-white rounded-xl shadow-md p-4 w-full">
        <h2 className="text-base font-bold text-slate-900 text-center mb-3">LANTAI</h2>
        <div className="space-y-3">
          {RAK_LANTAI.map((sl) => renderSlotCard(sl, true))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#16262f] font-sans text-slate-800 pb-8">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="w-11 h-11 rounded-full bg-slate-300 shrink-0 overflow-hidden flex items-center justify-center">
          <span className="text-lg">👤</span>
        </div>
        <div>
          <h1 className="text-xl font-extrabold text-white tracking-wide leading-tight">PA' EDI</h1>
          <p className="text-[11px] font-medium text-slate-400">Personal Asisten E-Display Information</p>
        </div>
      </div>

      {/* Search bar */}
      <div className="px-5 mb-5 flex justify-center">
        <div className="flex items-center gap-2 w-full max-w-md">
          <input
            className="flex-1 bg-white rounded-md px-3 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400"
            placeholder="Tulis nama..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button
            className="bg-[#f4c430] hover:bg-[#e0b420] text-slate-900 font-bold px-5 py-2 rounded-md text-sm transition-colors"
            onClick={loadRack}
            disabled={loading}
          >
            {loading ? '...' : 'Cari'}
          </button>
        </div>
      </div>

      {/* Rak A / B / C */}
      <div className="px-5 flex flex-col md:flex-row gap-4 mb-4">
        {renderBoardColumn("RAK A", RAK_A)}
        {renderBoardColumn("RAK B", RAK_B)}
        {renderBoardColumn("RAK C", RAK_C)}
      </div>

      {/* Lantai */}
      <div className="px-5 mb-5">
        {renderLantaiColumn()}
      </div>

      {/* Bottom strip: delete-by-name (UI only, belum ada logika), total, admin */}
      <div className="px-5 flex flex-col items-center gap-3">
        <div className="w-full max-w-2xl flex gap-2">
          <input
            className="flex-1 bg-white rounded-md px-3 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400"
            placeholder="Nama yang mau dihapus..."
            value={deleteNameInput}
            onChange={(e) => setDeleteNameInput(e.target.value)}
          />
          <button
            className="bg-red-600 hover:bg-red-700 text-white font-bold px-5 py-2 rounded-md text-sm transition-colors"
            onClick={() => alert('TODO: belum ada logika hapus-berdasarkan-nama. Beri tahu saya kalau mau disambungkan.')}
          >
            DELETE
          </button>
        </div>

        <div className="text-[#f4c430] font-bold text-sm">
          Total Sepatu: {totalSepatu}
        </div>

        <button
          className="bg-[#f4c430] hover:bg-[#e0b420] text-slate-900 font-bold px-6 py-2 rounded-md text-sm transition-colors"
          onClick={() => alert('TODO: belum ada halaman Konfigurasi Admin.')}
        >
          Konfigurasi Admin
        </button>
      </div>

      {/* ===================== MODALS (logika sama, style disesuaikan) ===================== */}

      {modalAdd && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex justify-center items-center p-4 z-50">
          <div className="bg-white w-full max-w-xs rounded-2xl p-5 flex flex-col items-center shadow-xl">
            <h3 className="text-base font-bold text-slate-800 mb-2">Suntik ke {addSlot}</h3>
            <div className="w-full relative mb-3">
              <input
                className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none uppercase"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                placeholder="Ketik nama / no nota..."
                autoFocus
              />
              {filteredSuggestions.length > 0 && (
                <div className="absolute left-0 right-0 mt-1 max-h-[110px] overflow-y-auto border border-slate-200 rounded-lg bg-white shadow-lg z-50">
                  {filteredSuggestions.map((tx) => (
                    <div
                      key={tx.id}
                      className="p-2 text-xs font-semibold text-blue-900 border-b border-slate-50 hover:bg-slate-50 cursor-pointer"
                      onClick={() => setAddName(`${tx.customer_name}#${tx.receipt_number}`)}
                    >
                      {tx.customer_name} ({tx.receipt_number})
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex gap-2 w-full mt-2">
              <button className="flex-1 bg-slate-100 text-slate-500 font-semibold text-xs py-2.5 rounded-lg" onClick={() => setModalAdd(false)}>Batal</button>
              <button className="flex-1 bg-yellow-300 text-amber-950 font-bold text-xs py-2.5 rounded-lg" onClick={handleAddNama} disabled={addLoading}>
                {addLoading ? '...' : 'Simpan'}
              </button>
            </div>
          </div>
        </div>
      )}

      {modalAction && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex justify-center items-center p-4 z-50">
          <div className="bg-white w-full max-w-xs rounded-2xl p-5 flex flex-col items-center shadow-xl">
            <h3 className="text-base font-bold text-slate-800 mb-2">Aksi Manajemen Rak</h3>
            <p className="text-xs text-slate-500 text-center mb-4 leading-relaxed">
              Pilih tindakan untuk nama <span className="font-bold text-slate-800">{selectedToken.split('#')[0]}</span> di slot {selectedSlot}:
            </p>
            <div className="w-full space-y-2">
              <button
                className="w-full border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-700 rounded-xl p-2.5 flex items-start flex-col transition-colors"
                onClick={handleAmbilBarang}
              >
                <span className="font-bold text-xs">Ambil / Serahkan Barang</span>
                <span className="text-[10px] text-blue-800/80 mt-0.5">Otomatis mengarsip nota kerja di monitor.</span>
              </button>
              <button
                className="w-full border border-red-200 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl p-2.5 flex items-start flex-col transition-colors"
                onClick={handlePureDelete}
              >
                <span className="font-bold text-xs">Hapus / Pindah Posisi Rak</span>
                <span className="text-[10px] text-red-800/80 mt-0.5">Hanya mengeluarkan nama tanpa mengubah nota.</span>
              </button>
              <button className="w-full bg-slate-100 text-slate-500 font-semibold text-xs py-2 rounded-lg mt-2" onClick={() => setModalAction(false)}>Kembali</button>
            </div>
          </div>
        </div>
      )}

      {payModalVisible && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex justify-center items-center p-4 z-50">
          <div className="bg-white w-full max-w-xs rounded-2xl p-5 flex flex-col items-center shadow-xl">
            <h3 className="text-base font-bold text-red-600 mb-2 text-center">🚨 Kasir Instan - Nota Belum Lunas</h3>
            {txToPay && (
              <div className="w-full bg-slate-50 p-2 rounded-lg mb-3 text-xs text-slate-600 space-y-0.5">
                <div>Nota: {txToPay.receipt_number}</div>
                <div>Pelanggan: {txToPay.customer_name}</div>
                <div className="text-red-600 font-bold">Wajib Bayar: Rp {(txToPay.debt_amount || 0).toLocaleString('id-ID')}</div>
              </div>
            )}
            <div className="w-full text-left text-[11px] font-semibold text-slate-600 mb-1">Pilih Metode Pembayaran</div>
            <div className="grid grid-cols-4 gap-1 w-full mb-3">
              {['Cash', 'Transfer', 'QRIS', 'Debit'].map(m => (
                <button
                  key={m}
                  className={`py-1.5 text-[11px] font-semibold border rounded-lg transition-colors ${paymentMethod === m ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200'}`}
                  onClick={() => setPaymentMethod(m)}
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="w-full text-left text-[11px] font-semibold text-slate-600 mb-1">Jumlah Uang Diterima (Rp)</div>
            <input
              type="number"
              className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm outline-none mb-3"
              value={amountPaid}
              onChange={(e) => setAmountPaid(e.target.value)}
              placeholder="0"
            />
            <div className="flex gap-2 w-full">
              <button className="flex-1 bg-slate-100 text-slate-500 font-semibold text-xs py-2 rounded-lg" onClick={() => setPayModalVisible(false)}>Batal</button>
              <button className="flex-1 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs py-2 rounded-lg" onClick={handleProcessPelunasanInstan} disabled={payLoading}>
                {payLoading ? '...' : 'Konfirmasi Lunas'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}