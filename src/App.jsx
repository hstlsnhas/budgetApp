import { useState, useEffect, useMemo } from "react";
import {
  PieChart, Pie, Cell, Tooltip as PTooltip, Legend, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as BTooltip
} from "recharts";

// ── Import koneksi Firebase & Auth ────────────────────────────────────────
import { db, auth, provider } from "./firebase"; 
import { collection, addDoc, onSnapshot, query, orderBy, deleteDoc, doc, updateDoc, where } from "firebase/firestore";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";

// ── Utils ──────────────────────────────────────────────────────────────────
const fmt = (v) => new Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", minimumFractionDigits: 0 }).format(v || 0);

const fmtShort = (v) => {
  const num = Number(v) || 0;
  const abs = Math.abs(num);
  const sign = num < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}jt`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(0)}rb`;
  return `${sign}${abs}`;
};

const fmtPeriode = (p) => { 
  if (!p || p === "ALL") return "Semua Waktu";
  const [y, m] = p.split("-"); 
  return new Date(y, m - 1).toLocaleDateString("id-ID", { month: "short", year: "2-digit" }); 
};

const PIE_COLORS = ["#6366f1","#8b5cf6","#ec4899","#f43f5e","#f97316","#eab308","#22c55e","#94a3b8"];
const JENIS_BADGE = {
  Pemasukan:   "bg-emerald-50 text-emerald-700 border-emerald-100",
  Pengeluaran: "bg-red-50 text-red-700 border-red-100",
  Mutasi:      "bg-amber-50 text-amber-700 border-amber-100",
};

// ── DITAMBAHKAN: Seabank dan Blu ──
const SUMBER_DANA_LIST = ["BNI", "ShopeePay", "GoPay", "OVO", "Tunai", "Seabank", "Blu"];
const KATEGORI_LIST = ["Gaji", "Makanan", "K-Pop & Merch", "Keluarga", "Transportasi", "Kebutuhan", "Transfer Internal", "Lainnya"];

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white shadow-xl rounded-xl px-3 py-2 sm:px-4 sm:py-3 border border-slate-100 text-xs">
      {label && <p className="font-semibold text-slate-700 mb-1">{label}</p>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5 sm:gap-2 mb-0.5">
          <span className="w-2 h-2 rounded-full" style={{ background: p.fill || p.color }} />
          <span className="text-slate-500">{p.name || p.dataKey}:</span>
          <span className="font-medium text-slate-700">{fmt(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

export default function App() {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [imgError, setImgError] = useState(false);

  const [tab, setTab] = useState("dashboard");
  const [transaksiList, setTransaksiList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPeriode, setSelectedPeriode] = useState("ALL");
  const [editingId, setEditingId] = useState(null);
  const [tanggal, setTanggal] = useState(new Date().toISOString().split("T")[0]);
  const [jenis, setJenis] = useState("Pengeluaran");
  const [kategori, setKategori] = useState("");
  const [sumberAsal, setSumberAsal] = useState("");
  const [sumberTujuan, setSumberTujuan] = useState("");
  const [nominalRaw, setNominalRaw] = useState("");
  const [deskripsi, setDeskripsi] = useState("");
  const [savedMsg, setSavedMsg] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setAuthLoading(false);
    });
    return () => unsubscribeAuth();
  }, []);

  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, "transaksi"), 
      where("uid", "==", user.uid),
      orderBy("tanggal", "desc")
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setTransaksiList(docs);
      setLoading(false);
    }, (error) => {
      console.error("Error reading Firebase:", error);
      setLoading(false);
    });
    return () => unsubscribe();
  }, [user]);

  const handleLogin = async () => {
    try { await signInWithPopup(auth, provider); } 
    catch (error) { alert("Gagal login dengan Google."); }
  };

  const handleLogout = async () => {
    if (window.confirm("Yakin ingin keluar?")) await signOut(auth);
  };

  const periodeOptions = useMemo(() => {
    const setP = new Set();
    transaksiList.forEach(t => { if (t.tanggal) setP.add(t.tanggal.substring(0, 7)); });
    return Array.from(setP).sort((a, b) => b.localeCompare(a));
  }, [transaksiList]);

  // Pisahkan transaksi bulan ini vs transaksi bulan-bulan sebelumnya
  const { filteredTransaksi, prevTransaksi } = useMemo(() => {
    if (selectedPeriode === "ALL") return { filteredTransaksi: transaksiList, prevTransaksi: [] };
    
    const targetDate = selectedPeriode + "-01";
    return {
      filteredTransaksi: transaksiList.filter(t => t.tanggal && t.tanggal.startsWith(selectedPeriode)),
      prevTransaksi: transaksiList.filter(t => t.tanggal && t.tanggal < targetDate) // Semua transaksi sblm tgl 1 bulan ini
    };
  }, [transaksiList, selectedPeriode]);

  // ── LOGIKA REKAPITULASI DENGAN SALDO AWAL (CERDAS) ──
  const rekapData = SUMBER_DANA_LIST.map(nama => {
    let saldoAwal = 0;
    let masuk = 0;
    let keluar = 0;
    let mutasi_keluar = 0;

    // 1. Hitung Saldo Awal dari transaksi bulan-bulan sebelumnya
    prevTransaksi.forEach(t => {
      if (t.sumber === nama) {
        if (t.jenis === "Pemasukan") saldoAwal += t.nominal;
        if (t.jenis === "Pengeluaran") saldoAwal -= t.nominal;
        if (t.jenis === "Mutasi") saldoAwal -= t.nominal;
      }
      if (t.jenis === "Mutasi" && t.sumberTujuan === nama) {
        saldoAwal += t.nominal;
      }
    });

    // 2. Hitung pergerakan uang khusus di bulan terpilih
    filteredTransaksi.forEach(t => {
      if (t.sumber === nama) {
        if (t.jenis === "Pemasukan") masuk += t.nominal;
        if (t.jenis === "Pengeluaran") keluar += t.nominal;
        if (t.jenis === "Mutasi") mutasi_keluar += t.nominal;
      }
      if (t.jenis === "Mutasi" && t.sumberTujuan === nama) { 
        masuk += t.nominal; // Mutasi masuk ditambahkan ke pemasukan dompet tujuan
      }
    });

    // 3. Saldo Akhir adalah sisa mutlak
    const sisa = saldoAwal + masuk - keluar - mutasi_keluar;
    return { sumber: nama, saldoAwal, masuk, keluar, mutasi_keluar, sisa };
  });

  const totalSaldo = rekapData.reduce((acc, r) => acc + r.sisa, 0);
  const rawNominal = parseInt(nominalRaw.replace(/\D/g, "")) || 0;

  const pieDataMap = {};
  filteredTransaksi.filter(t => t.jenis === "Pengeluaran").forEach(t => {
    pieDataMap[t.kategori] = (pieDataMap[t.kategori] || 0) + t.nominal;
  });
  const chartPie = Object.keys(pieDataMap).map(k => ({ nama: k, total: pieDataMap[k] }));

  const barDataMap = {};
  filteredTransaksi.forEach(t => {
    const periode = t.tanggal ? t.tanggal.substring(0, 7) : "Lainnya";
    if (!barDataMap[periode]) barDataMap[periode] = { periode, masuk: 0, keluar: 0 };
    if (t.jenis === "Pemasukan") barDataMap[periode].masuk += t.nominal;
    if (t.jenis === "Pengeluaran") barDataMap[periode].keluar += t.nominal;
  });
  const chartBar = Object.values(barDataMap).sort((a, b) => a.periode.localeCompare(b.periode));

  const resetForm = () => {
    setEditingId(null);
    setTanggal(new Date().toISOString().split("T")[0]);
    setJenis("Pengeluaran");
    setKategori("");
    setSumberAsal("");
    setSumberTujuan("");
    setNominalRaw("");
    setDeskripsi("");
  };

  const handleStartEdit = (t) => {
    setEditingId(t.id);
    setTanggal(t.tanggal || new Date().toISOString().split("T")[0]);
    setJenis(t.jenis || "Pengeluaran");
    setKategori(t.kategori || "");
    setSumberAsal(t.sumber || "");
    setSumberTujuan(t.sumberTujuan || "");
    setNominalRaw(t.nominal ? t.nominal.toLocaleString("id-ID") : "");
    setDeskripsi(t.deskripsi || "");
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Yakin mau menghapus transaksi ini?")) return;
    try {
      await deleteDoc(doc(db, "transaksi", id));
      setSavedMsg("🗑️ Transaksi berhasil dihapus!");
      setTimeout(() => setSavedMsg(""), 3000);
    } catch (err) { alert("Gagal menghapus transaksi."); }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    if (!rawNominal || !sumberAsal || !kategori) return alert("Harap isi semua kolom wajib (*)");
    setIsSubmitting(true);
    
    try {
      const payload = {
        uid: user.uid,
        tanggal, jenis, kategori,
        sumber: sumberAsal,
        sumberTujuan: jenis === "Mutasi" ? sumberTujuan : "",
        nominal: rawNominal, deskripsi,
        updatedAt: new Date().toISOString()
      };

      if (editingId) {
        await updateDoc(doc(db, "transaksi", editingId), payload);
        setSavedMsg("✓ Transaksi diperbarui!");
      } else {
        payload.createdAt = new Date().toISOString();
        await addDoc(collection(db, "transaksi"), payload);
        setSavedMsg("✓ Transaksi tersimpan!");
      }

      resetForm();
      setTimeout(() => setSavedMsg(""), 3000);
    } catch (err) { alert("Gagal menyimpan transaksi!"); }
    finally { setIsSubmitting(false); }
  };

  const handleNominalChange = (e) => {
    const raw = e.target.value.replace(/\D/g, "");
    setNominalRaw(raw ? parseInt(raw).toLocaleString("id-ID") : "");
  };

  const tabs = [
    { id: "dashboard", label: "Dashboard" },
    { id: "transaksi", label: "Transaksi" },
    { id: "rekap",     label: "Rekapitulasi" },
  ];

  if (authLoading) return <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500">Mengecek sesi...</div>;

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white p-8 rounded-2xl shadow-xl shadow-indigo-100 text-center border border-slate-100">
          <div className="w-14 h-14 mx-auto bg-indigo-600 rounded-2xl flex items-center justify-center mb-5 shadow-md shadow-indigo-200">
            <span className="text-white text-2xl font-black">B</span>
          </div>
          <h1 className="text-xl font-bold text-slate-800 mb-2">BudgetApp</h1>
          <p className="text-sm text-slate-500 mb-8">Catat dan pantau keuanganmu dengan aman di cloud.</p>
          <button onClick={handleLogin} className="w-full py-3 bg-white border-2 border-slate-200 hover:border-indigo-400 hover:bg-indigo-50 text-slate-700 font-semibold rounded-xl transition-all flex items-center justify-center gap-3 active:scale-95">
            <svg className="w-5 h-5" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" /><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" /><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" /><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" /></svg>
            Masuk dengan Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans antialiased">
      <nav className="bg-white border-b border-slate-100 sticky top-0 z-20 shadow-sm">
        <div className="max-w-6xl mx-auto px-3 sm:px-4 flex items-center justify-between h-16">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shrink-0 shadow-md">
              <span className="text-white text-xs font-black">B</span>
            </div>
            <div className="hidden sm:block">
              <p className="font-bold text-slate-800 text-sm leading-tight">BudgetApp</p>
              <p className="text-[10px] text-slate-400 font-medium truncate max-w-[120px]">{user.email}</p>
            </div>
          </div>
          
          <div className="flex gap-1 overflow-x-auto py-1 no-scrollbar flex-1 justify-center mx-2 sm:mx-6">
            {tabs.map(t => (
              <button key={t.id} onClick={() => setTab(t.id)} className={`px-3 sm:px-4 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition-all whitespace-nowrap ${tab === t.id ? "bg-indigo-600 text-white shadow-sm" : "text-slate-500 hover:bg-slate-100"}`}>
                {t.label}
              </button>
            ))}
          </div>

          <button onClick={handleLogout} title="Keluar" className="w-8 h-8 rounded-full bg-slate-100 border border-slate-200 overflow-hidden shrink-0 hover:ring-2 ring-indigo-400 transition-all focus:outline-none flex items-center justify-center">
            {user.photoURL && !imgError ? (
              <img src={user.photoURL} alt="User" referrerPolicy="no-referrer" onError={() => setImgError(true)} className="w-full h-full object-cover" />
            ) : (
              <span className="text-slate-500 text-xs font-bold uppercase">{user.email.charAt(0)}</span>
            )}
          </button>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-5">
        {loading ? (
          <div className="text-center py-20 text-slate-400 text-sm">Menghubungkan ke Firebase...</div>
        ) : (
          <>
            {(tab === "dashboard" || tab === "rekap") && (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-3.5 sm:px-5 sm:py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2.5 sm:gap-4">
                <div className="flex items-center gap-2.5 w-full sm:w-auto">
                  <span className="text-[10px] sm:text-xs font-semibold text-slate-500 uppercase tracking-wider whitespace-nowrap">Periode:</span>
                  <select value={selectedPeriode} onChange={e => setSelectedPeriode(e.target.value)} className="w-full sm:w-auto border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs sm:text-sm bg-slate-50 font-medium text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-400">
                    <option value="ALL">🌐 Semua Waktu (ALL)</option>
                    {periodeOptions.map(p => <option key={p} value={p}>📅 {fmtPeriode(p)}</option>)}
                  </select>
                </div>
                <span className="text-[11px] sm:text-xs text-slate-400 self-end sm:self-auto">{filteredTransaksi.length} transaksi filter</span>
              </div>
            )}

            {tab === "dashboard" && (
              <>
                <div className="bg-gradient-to-br from-indigo-600 via-indigo-700 to-violet-700 rounded-2xl p-4 sm:p-6 text-white shadow-xl shadow-indigo-100">
                  <p className="text-indigo-200 text-[10px] sm:text-xs font-semibold tracking-widest uppercase">
                    Total Saldo Akhir ({selectedPeriode === "ALL" ? "Semua Waktu" : fmtPeriode(selectedPeriode)})
                  </p>
                  <p className="text-2xl sm:text-4xl font-black mt-1 sm:mt-2 mb-4 sm:mb-5 tracking-tight break-words">
                    {fmt(totalSaldo)}
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
                    {rekapData.map(r => (
                      <div key={r.sumber} className="bg-white/10 backdrop-blur-sm rounded-xl p-2 sm:p-2.5">
                        <p className="text-indigo-200 text-[10px] leading-tight truncate">{r.sumber}</p>
                        <p className="text-white text-xs sm:text-sm font-bold mt-0.5 sm:mt-1 truncate">{fmtShort(r.sisa)}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-5">
                  <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 sm:p-5">
                    <h3 className="font-semibold text-slate-800 text-xs sm:text-sm mb-0.5">Pengeluaran per Kategori</h3>
                    <p className="text-[11px] sm:text-xs text-slate-400 mb-3">Bulan Ini: {fmt(chartPie.reduce((s, d) => s + d.total, 0))}</p>
                    {chartPie.length === 0 ? (
                      <div className="h-44 sm:h-56 flex items-center justify-center text-xs text-slate-400">Belum ada data pengeluaran</div>
                    ) : (
                      <ResponsiveContainer width="100%" height={220}>
                        <PieChart>
                          <Pie data={chartPie} cx="50%" cy="45%" innerRadius={45} outerRadius={75} paddingAngle={3} dataKey="total" nameKey="nama">
                            {chartPie.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                          </Pie>
                          <PTooltip content={<ChartTooltip />} />
                          <Legend formatter={v => <span className="text-[10px] sm:text-[11px] text-slate-500">{v}</span>} />
                        </PieChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                  <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 sm:p-5">
                    <h3 className="font-semibold text-slate-800 text-xs sm:text-sm mb-3">Pemasukan vs Pengeluaran</h3>
                    {chartBar.length === 0 ? (
                      <div className="h-44 sm:h-56 flex items-center justify-center text-xs text-slate-400">Belum ada grafik transaksi</div>
                    ) : (
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={chartBar} barCategoryGap="25%" barGap={2}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                          <XAxis dataKey="periode" tickFormatter={fmtPeriode} tick={{ fontSize: 9, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                          <YAxis tickFormatter={fmtShort} tick={{ fontSize: 9, fill: "#94a3b8" }} axisLine={false} tickLine={false} width={35} />
                          <BTooltip content={<ChartTooltip />} />
                          <Legend formatter={v => <span className="text-[10px] sm:text-[11px] text-slate-500">{v}</span>} />
                          <Bar dataKey="masuk" name="Pemasukan" fill="#6366f1" radius={[3, 3, 0, 0]} />
                          <Bar dataKey="keluar" name="Pengeluaran" fill="#f43f5e" radius={[3, 3, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>
              </>
            )}

            {tab === "transaksi" && (
              <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 sm:gap-5 items-start">
                <div className="lg:col-span-2 bg-white rounded-2xl border border-slate-100 shadow-sm p-4 sm:p-5">
                  <div className="flex items-center justify-between mb-3 sm:mb-4">
                    <h2 className="font-semibold text-slate-800 text-sm sm:text-base">
                      {editingId ? "✏️ Edit Transaksi" : "+ Tambah Transaksi"}
                    </h2>
                    {editingId && <button type="button" onClick={resetForm} className="text-xs text-slate-400 hover:text-slate-600 underline">Batal</button>}
                  </div>
                  {savedMsg && <div className="mb-3 p-2.5 bg-emerald-50 text-emerald-700 rounded-lg text-xs">{savedMsg}</div>}
                  <form onSubmit={handleSave} className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Tanggal *</label>
                      <input type="date" value={tanggal} onChange={e => setTanggal(e.target.value)} required className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Jenis *</label>
                        <select value={jenis} onChange={e => setJenis(e.target.value)} className="w-full border rounded-lg px-2.5 py-2 text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400">
                          {["Pemasukan", "Pengeluaran", "Mutasi"].map(j => <option key={j}>{j}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-slate-500 mb-1">Kategori *</label>
                        <select value={kategori} onChange={e => setKategori(e.target.value)} required className="w-full border rounded-lg px-2.5 py-2 text-xs sm:text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400">
                          <option value="">-- Pilih --</option>
                          {KATEGORI_LIST.map(k => <option key={k}>{k}</option>)}
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">{jenis === "Mutasi" ? "Sumber Dana Asal *" : "Sumber Dana *"}</label>
                      <select value={sumberAsal} onChange={e => setSumberAsal(e.target.value)} required className="w-full border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-400">
                        <option value="">-- Pilih --</option>
                        {SUMBER_DANA_LIST.map(s => <option key={s}>{s}</option>)}
                      </select>
                    </div>
                    {jenis === "Mutasi" && (
                      <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl">
                        <label className="block text-xs font-semibold text-amber-800 mb-1">Sumber Dana Tujuan *</label>
                        <select value={sumberTujuan} onChange={e => setSumberTujuan(e.target.value)} required className="w-full border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-amber-400">
                          <option value="">-- Pilih Tujuan --</option>
                          {SUMBER_DANA_LIST.map(s => <option key={s}>{s}</option>)}
                        </select>
                      </div>
                    )}
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Nominal (Rp) *</label>
                      <input type="text" inputMode="numeric" value={nominalRaw} onChange={handleNominalChange} placeholder="0" required className="w-full border rounded-lg px-3 py-2 text-sm text-right focus:outline-none focus:ring-2 focus:ring-indigo-400" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-slate-500 mb-1">Deskripsi</label>
                      <input type="text" value={deskripsi} onChange={e => setDeskripsi(e.target.value)} placeholder="Keterangan..." className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400" />
                    </div>
                    <button type="submit" disabled={isSubmitting} className={`w-full py-2.5 sm:py-3 text-white text-sm font-semibold rounded-xl shadow-md transition-all active:scale-95 ${editingId ? "bg-amber-600 hover:bg-amber-700" : "bg-indigo-600 hover:bg-indigo-700"}`}>
                      {isSubmitting ? "Menyimpan..." : editingId ? "✓ Update Transaksi" : "+ Simpan Transaksi"}
                    </button>
                  </form>
                </div>

                <div className="lg:col-span-3 bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                  <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-slate-100 flex items-center justify-between">
                    <h3 className="font-semibold text-slate-800 text-xs sm:text-sm">Riwayat Transaksi (Akumulasi)</h3>
                    <span className="text-[11px] sm:text-xs text-slate-400">{transaksiList.length} Transaksi Keseluruhan</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-slate-50">
                          {["Tanggal", "Deskripsi", "Kategori", "Sumber", "Nominal", "Jenis", "Aksi"].map(h => (
                            <th key={h} className={`px-3 sm:px-4 py-2.5 sm:py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap ${h === "Aksi" ? "text-center" : h === "Nominal" ? "text-right" : ""}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50 text-[11px] sm:text-xs">
                        {transaksiList.length === 0 ? (
                          <tr><td colSpan={7} className="text-center py-8 text-slate-400">Belum ada transaksi tersimpan.</td></tr>
                        ) : (
                          transaksiList.map(t => (
                            <tr key={t.id} className="hover:bg-slate-50/60 transition-colors">
                              <td className="px-3 sm:px-4 py-2.5 sm:py-3 text-slate-500 whitespace-nowrap">{t.tanggal}</td>
                              <td className="px-3 sm:px-4 py-2.5 sm:py-3 text-slate-700 font-medium max-w-[100px] sm:max-w-[120px] truncate">{t.deskripsi || "-"}</td>
                              <td className="px-3 sm:px-4 py-2.5 sm:py-3 text-slate-500 whitespace-nowrap">{t.kategori}</td>
                              <td className="px-3 sm:px-4 py-2.5 sm:py-3 text-slate-500 whitespace-nowrap">{t.jenis === "Mutasi" ? `${t.sumber} ➔ ${t.sumberTujuan}` : t.sumber}</td>
                              <td className="px-3 sm:px-4 py-2.5 sm:py-3 text-right font-semibold text-slate-700 whitespace-nowrap">{fmt(t.nominal)}</td>
                              <td className="px-3 sm:px-4 py-2.5 sm:py-3 whitespace-nowrap">
                                <span className={`inline-flex px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-semibold border ${JENIS_BADGE[t.jenis]}`}>{t.jenis}</span>
                              </td>
                              <td className="px-3 sm:px-4 py-2.5 sm:py-3 text-center whitespace-nowrap">
                                <div className="flex items-center justify-center gap-1.5 sm:gap-2">
                                  <button onClick={() => handleStartEdit(t)} title="Edit" className="p-1 text-slate-400 hover:text-amber-600 transition-colors">✏️</button>
                                  <button onClick={() => handleDelete(t.id)} title="Hapus" className="p-1 text-slate-400 hover:text-red-600 transition-colors">🗑️</button>
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {tab === "rekap" && (
              <div className="space-y-4">
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
                    <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">
                      Alur Uang {selectedPeriode === "ALL" ? "Keseluruhan" : `Bulan ${fmtPeriode(selectedPeriode)}`}
                    </h3>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-white">
                          {["Sumber Dana", "Saldo Awal", "Mutasi (+)", "Pemasukan", "Pengeluaran", "Mutasi (-)", "Saldo Akhir"].map(h => (
                            <th key={h} className={`px-4 sm:px-5 py-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap ${h === "Sumber Dana" ? "text-left" : "text-right"}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50 text-xs sm:text-sm">
                        {rekapData.map(r => (
                          <tr key={r.sumber} className="hover:bg-slate-50/60 transition-colors">
                            <td className="px-4 sm:px-5 py-3 font-semibold text-slate-700 whitespace-nowrap">{r.sumber}</td>
                            <td className="px-4 sm:px-5 py-3 text-right text-slate-500 font-medium whitespace-nowrap">{fmt(r.saldoAwal)}</td>
                            {/* Di UI, pemasukan yang berasal dari mutasi kita tampilkan secara terpisah (opsional, tp di sini digabung dalam Pemasukan demi kesederhanaan, namun dilabel Pemasukan Total) */}
                            <td className="px-4 sm:px-5 py-3 text-right text-emerald-500 whitespace-nowrap">{(r.masuk && r.sumber.includes("➔")) ? "-" : ""} - </td>
                            <td className="px-4 sm:px-5 py-3 text-right text-slate-600 whitespace-nowrap">{fmt(r.masuk)}</td>
                            <td className="px-4 sm:px-5 py-3 text-right text-slate-600 whitespace-nowrap">{fmt(r.keluar)}</td>
                            <td className="px-4 sm:px-5 py-3 text-right text-amber-600 whitespace-nowrap">{fmt(r.mutasi_keluar)}</td>
                            <td className={`px-4 sm:px-5 py-3 text-right font-bold whitespace-nowrap ${r.sisa >= 0 ? "text-indigo-600" : "text-red-600"}`}>{fmt(r.sisa)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-indigo-50 border-t-2 border-indigo-100 text-xs sm:text-sm">
                          <td className="px-4 sm:px-5 py-3 font-black text-slate-800">TOTAL</td>
                          {[
                            rekapData.reduce((s,r)=>s+r.saldoAwal,0),
                            0, // Kolom filler untuk Mutasi (+) supaya layout rapi
                            rekapData.reduce((s,r)=>s+r.masuk,0),
                            rekapData.reduce((s,r)=>s+r.keluar,0),
                            rekapData.reduce((s,r)=>s+r.mutasi_keluar,0),
                            rekapData.reduce((s,r)=>s+r.sisa,0),
                          ].map((v, i) => (
                            <td key={i} className={`px-4 sm:px-5 py-3 text-right font-black whitespace-nowrap ${i === 5 ? "text-indigo-700" : i === 1 ? "text-transparent" : "text-slate-800"}`}>
                              {i === 1 ? "-" : fmt(v)}
                            </td>
                          ))}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}