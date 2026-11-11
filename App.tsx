
import React, {useState, useEffect, useRef} from 'react';
import { Layout } from './components/Layout';
import { Dashboard } from './components/Dashboard';
import { ServiceForm } from './components/ServiceForm';
import { ChatInbox } from './components/ChatInbox';
import { LeadPipeline } from './components/LeadPipeline';
import { BusinessDeals } from './components/BusinessDeals';
import { LoginScreen } from './components/LoginScreen';
import { ClientsList } from './components/ClientsList';
import { WhatsAppChannels } from './components/WhatsAppChannels';
import { CapacityWidget } from './components/CapacityWidget';
import { AuditModule } from './components/AuditModule';
import { DashboardSkeleton, ListSkeleton } from './components/Skeleton';
import { MessageSquare, X, BellRing, ChevronRight, CheckCircle2, AlertCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { io } from 'socket.io-client';
import { ServiceRecord, ViewState, StaffMember, ChatConversation, CurrentUser, ChatMessage, LeadRecord, LeadStatus, DealStatus, ClientSummary, ClientReminder } from './types';
import { notificationService } from './utils/NotificationService';
import { apiFetch, getToken, clearAuth } from './lib/api';
import { loadBranding } from './lib/branding';
import { BrandingSettings } from './components/BrandingSettings';
import { SystemStatus } from './components/SystemStatus';
import { Invoices } from './components/Invoices';
import { SalonDashboard } from './components/SalonDashboard';
import { SalonsAdmin } from './components/SalonsAdmin';
import { SalonAgenda } from './components/SalonAgenda';
import { SalonCatalog } from './components/SalonCatalog';
import { SalonRetouches } from './components/SalonRetouches';
import { SalonClients } from './components/SalonClients';
import { SalonPOS } from './components/SalonPOS';
import { SalonProducts } from './components/SalonProducts';
import { SalonLiquidations } from './components/SalonLiquidations';
import { SalonToday } from './components/SalonToday';
import { SalonTeam } from './components/SalonTeam';
import { SalonSettings } from './components/SalonSettings';
import { PublicBooking } from './components/PublicBooking';

export default function App() {
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(() => {
    try {
      const savedUser = localStorage.getItem('salonos_session');
      return savedUser ? JSON.parse(savedUser) : null;
    } catch (e) {
      console.error("Error recuperando sesión", e);
      return null;
    }
  });

  const [currentView, setCurrentView] = useState<ViewState>('dashboard');
  const [isLoading, setIsLoading] = useState(true);
  const [preselectedChatPhone, setPreselectedChatPhone] = useState<string | null>(null);
  
  const [services, setServices] = useState<ServiceRecord[]>([]);
  const [totalServices, setTotalServices] = useState(0);
  const [servicesPage, setServicesPage] = useState(1);
  const [servicesSearch, setServicesSearch] = useState('');
  const [servicesFilters, setServicesFilters] = useState<any>({ startDate: '', endDate: '', location: 'all', staff: 'all', payment: 'all' });

  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [totalLeads, setTotalLeads] = useState(0);
  const [leadsPage, setLeadsPage] = useState(1);
  const [leadsSearch, setLeadsSearch] = useState('');
  const [leadsFilters, setLeadsFilters] = useState<any>({ status: 'all', startDate: '', endDate: '', location: 'all', source: 'all', minPrice: '', maxPrice: '', advisor: 'all' });

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [chats, setChats] = useState<ChatConversation[]>([]);
  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [totalClients, setTotalClients] = useState(0);
  const [clientsPage, setClientsPage] = useState(1);
  const [clientsSearch, setClientsSearch] = useState('');
  const [clientsFilters, setClientsFilters] = useState({ city: 'all', type: 'all', spentRange: 'all' });

  const [activeAlarms, setActiveAlarms] = useState<ClientReminder[]>([]);
  
  const prevChatUnreadTotal = useRef(0);
  // La carga inicial ya trae todo (fetchData('all')); sin esta guarda, los
  // 3 efectos de filtros disparan además 3 fetchData al montar.
  const firstFetchDone = useRef(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState({ title: '', description: '', type: 'info' as 'info' | 'success' | 'error' });
  
  const [isServiceFormOpen, setIsServiceFormOpen] = useState(false);
  const [editingService, setEditingService] = useState<ServiceRecord | null>(null);
  const [prefillData, setPrefillData] = useState<any>(null);

  const triggerToast = (title: string, description: string, type: 'info' | 'success' | 'error' = 'info') => {
    setToastMessage({ title, description, type });
    setShowToast(true);
    setTimeout(() => setShowToast(false), 5000);
  };

  useEffect(() => {
    if (currentUser) {
      localStorage.setItem('salonos_session', JSON.stringify(currentUser));
      
      const socket = io(window.location.origin, { auth: { token: getToken() } });
      socket.on('connect', () => {
        socket.emit('identify', { id: currentUser.id, role: currentUser.role });
      });

      socket.on('data_update', (data: any) => {
        // Refrescar solo lo necesario basado en data.type si es posible
        if (data.type === 'chat' || data.type === 'webhook_message') fetchData('all');
        else if (data.type === 'lead') fetchData('leads');
        else if (data.type === 'service' || data.type === 'service_status') fetchData('services');
        else fetchData('all');
      });

      return () => {
        socket.disconnect();
      };
    } else {
      localStorage.removeItem('salonos_session');
    }
  }, [currentUser]);

  const fetchData = async (target?: 'leads' | 'services' | 'clients' | 'all') => {
    if (!currentUser) return;
    
    try {
      const leadsUrl = `/api/leads?page=${leadsPage}&search=${encodeURIComponent(leadsSearch)}&status=${leadsFilters.status}&startDate=${leadsFilters.startDate}&endDate=${leadsFilters.endDate}&location=${encodeURIComponent(leadsFilters.location)}&source=${leadsFilters.source}&minPrice=${leadsFilters.minPrice}&maxPrice=${leadsFilters.maxPrice}&advisor=${encodeURIComponent(leadsFilters.advisor)}`;
      const servicesUrl = `/api/services?page=${servicesPage}&search=${encodeURIComponent(servicesSearch)}&startDate=${servicesFilters.startDate}&endDate=${servicesFilters.endDate}&location=${encodeURIComponent(servicesFilters.location)}&staff=${encodeURIComponent(servicesFilters.staff)}&payment=${servicesFilters.payment || 'all'}`;
      const clientsUrl = `/api/clients?page=${clientsPage}&search=${encodeURIComponent(clientsSearch)}&city=${encodeURIComponent(clientsFilters.city)}&type=${clientsFilters.type}&spentRange=${clientsFilters.spentRange}`;
      
      const requests: any = {};
      
      if (!target || target === 'all' || target === 'leads') requests.leads = apiFetch(leadsUrl);
      if (!target || target === 'all' || target === 'services') requests.services = apiFetch(servicesUrl);
      if (!target || target === 'all' || target === 'clients') requests.clients = apiFetch(clientsUrl);
      
      if (!target || target === 'all') {
        requests.staff = apiFetch('/api/staff');
        requests.chats = apiFetch('/api/chats');
        requests.alarms = apiFetch('/api/active-reminders');
      }

      const keys = Object.keys(requests);
      const responses = await Promise.all(keys.map(k => requests[k]));
      
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const res = responses[i];
        if (!res.ok) continue;
        
        const data = await res.json();
        
        if (key === 'leads') {
          setLeads(data.data);
          setTotalLeads(data.total);
        } else if (key === 'services') {
          setServices(data.data);
          setTotalServices(data.total);
        } else if (key === 'clients') {
          setClients(data.data);
          setTotalClients(data.total);
        } else if (key === 'staff') {
          setStaff(data);
        } else if (key === 'chats') {
          setChats(data);
          const currentChatUnread = data.reduce((acc: number, curr: any) => acc + (curr.unreadCount || 0), 0);
          if (currentChatUnread > prevChatUnreadTotal.current && currentView !== 'inbox' && currentUser.role !== 'operator') {
            notificationService.playReceived();
            triggerToast('Mensaje Nuevo', 'Has recibido un nuevo mensaje en el inbox.', 'info');
          }
          prevChatUnreadTotal.current = currentChatUnread;
        } else if (key === 'alarms') {
          if (data.length > 0 && data.length > activeAlarms.length) {
            notificationService.playAlert();
            triggerToast('Recordatorio', `Tienes ${data.length} recordatorios pendientes.`, 'info');
          }
          setActiveAlarms(data);
        }
      }
    } catch (e) { 
      console.error(e); 
    } finally {
      if (isLoading) setIsLoading(false);
    }
  };

  useEffect(() => {
    if (currentUser) {
      fetchData('all').finally(() => { firstFetchDone.current = true; });
    }
  }, [currentUser]);

  useEffect(() => {
    if (currentUser && firstFetchDone.current) fetchData('leads');
  }, [leadsPage, leadsSearch, leadsFilters]);

  useEffect(() => {
    if (currentUser && firstFetchDone.current) fetchData('services');
  }, [servicesPage, servicesSearch, servicesFilters]);

  useEffect(() => {
    if (currentUser && firstFetchDone.current) fetchData('clients');
  }, [clientsPage, clientsSearch, clientsFilters]);

  const handleUpdateLeadStatus = async (id: string, status: LeadStatus, isConvId: boolean, reason?: string) => {
    try {
      const res = await apiFetch('/api/leads/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: isConvId ? id : undefined, leadId: !isConvId ? id : undefined, status, lostReason: reason })
      });
      if (res.ok) fetchData();
    } catch (e) { console.error(e); }
  };

  const handleUpdateDealStatus = async (serviceId: string, status: DealStatus, reason?: string, newDate?: string, newTime?: string) => {
    try {
      const body: any = { id: serviceId, status, reason };
      if (status === DealStatus.RESCHEDULED && newDate) {
        body.date = newDate;
        body.time = newTime;
      }

      const res = await apiFetch(`/api/services/update-deal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) fetchData();
    } catch (e) { console.error(e); }
  };

  const handleSaveService = async (data: ServiceRecord) => {
    try {
      const res = await apiFetch('/api/services', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (res.ok) {
        fetchData();
        setIsServiceFormOpen(false);
        setEditingService(null);
        setPrefillData(null);
        return data.id;
      }
    } catch (e) { console.error(e); }
    return null;
  };

  const handleDeleteClient = async (phone: string) => {
    if (currentUser?.role !== 'admin') {
      alert('Solo los administradores pueden realizar esta acción.');
      return;
    }
    if (!confirm('¿Seguro que deseas eliminar permanentemente a este cliente? Se borrarán todos sus chats, prospectos e historial de servicios. Esta acción no se puede deshacer.')) return;
    try {
      const res = await apiFetch(`/api/clients/${encodeURIComponent(phone)}`, { method: 'DELETE' });
      if (res.ok) fetchData();
    } catch (e) { console.error(e); }
  };

  // (handleSaveStaff/handleRemoveStaff eliminados en la auditoría v1.1:
  // solo los usaba TeamManagement, componente muerto que se borró.
  // El equipo del salón se gestiona en SalonTeam.)

  const handleOpenFullService = (phone: string, leadData: any) => {
    const chat = chats.find(c => c.clientPhone === phone);
    const leadImages = leadData.technicalImages || chat?.leadData?.technicalImages || [];
    const existing = services.find(s => s.clientPhone === phone);
    
    const currentItems = leadData.items || leadData.itemsToClean || leadData.items_to_clean || chat?.leadData?.itemsToClean || '';
    const currentAddress = leadData.address || chat?.leadData?.address || '';
    const currentLocation = leadData.location || chat?.leadData?.location || '';
    const currentName = leadData.name || leadData.clientName || chat?.clientName || '';
    const currentValue = leadData.value || leadData.estimatedValue || chat?.leadData?.estimatedValue || 0;

    if (existing) {
      setEditingService({ 
        ...existing, 
        itemsToClean: currentItems || existing.itemsToClean,
        address: currentAddress || existing.address,
        neighborhood: currentLocation || existing.neighborhood,
        clientName: currentName || existing.clientName,
        initialValue: currentValue > 0 ? currentValue : existing.initialValue,
        technicalImages: [...new Set([...(existing.technicalImages || []), ...leadImages])] 
      });
    } else {
      setPrefillData({
        name: currentName,
        phone: phone,
        advisor: leadData.advisor || currentUser?.name || '',
        value: currentValue,
        items: currentItems,
        address: currentAddress,
        location: currentLocation,
        technicalImages: leadImages
      });
    }
    setIsServiceFormOpen(true);
  };

  const handleLocalMessage = async (conversationId: string, message: ChatMessage) => {
    try {
      notificationService.playSent();
      const res = await apiFetch(`/api/chats/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: message.content,
          type: message.type,
          attachmentUrl: message.attachmentUrl
        })
      });
      if (res.ok) fetchData();
    } catch (e) { console.error(e); }
  };

  const handleCompleteAlarm = async (id: string, phone: string) => {
    try {
      await apiFetch(`/api/reminders/${id}/complete`, { method: 'POST' });
      fetchData();
      handleGoToChat(phone);
    } catch (e) { console.error(e); }
  };

  const handleGoToChat = (phone: string) => {
    setPreselectedChatPhone(phone);
    setCurrentView('inbox');
  };

  const handleLogout = () => {
    setCurrentUser(null);
    clearAuth();
  };

  useEffect(() => { loadBranding().catch(() => {}); }, []);

  // v1.3: verificar la sesión contra el servidor al cargar (cookie HttpOnly
  // o token de salón en localStorage). Sin sesión válida se va al login.
  // Con fetch plano (no apiFetch) para no recargar en bucle si expiró; en
  // 503 (DB caída) no se cierra la sesión, solo fallan las cargas.
  useEffect(() => {
    const headers: Record<string, string> = {};
    const t = getToken();
    if (t) headers['Authorization'] = `Bearer ${t}`;
    fetch('/api/auth/me', { credentials: 'include', headers }).then(async (r) => {
      if (r.status === 401) { clearAuth(); setCurrentUser(null); return; }
      if (!r.ok) return;
      const d = await r.json().catch(() => null);
      if (d?.user) setCurrentUser(d.user);
    }).catch(() => { /* sin conexión: se queda la sesión guardada */ });
  }, []);

  // Reserva pública por slug: sin login, solo la marca del salón.
  const _pubPath = window.location.pathname;
  if (_pubPath.startsWith('/reserva/')) {
    const _slug = _pubPath.split('/')[2] || '';
    return <PublicBooking slug={_slug} />;
  }

  if (!currentUser) return <LoginScreen onLogin={setCurrentUser} />;

  const renderView = () => {
    if (isLoading) {
      if (currentView === 'dashboard') return <DashboardSkeleton />;
      return <ListSkeleton />;
    }

    switch (currentView) {
      case 'dashboard':
        return <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
      case 'salones':
        return currentUser.role === 'superadmin' ? <SalonsAdmin currentUser={currentUser} onEnterSalon={(u: any) => { setCurrentUser(u); setCurrentView('salon-dashboard'); }} /> : <SalonDashboard currentUser={currentUser} />;
      case 'salon-dashboard':
        return <SalonDashboard currentUser={currentUser} />;
      case 'hoy':
        return <SalonToday currentUser={currentUser} />;
      case 'agenda':
        return <SalonAgenda currentUser={currentUser} />;
      case 'catalogo':
        return <SalonCatalog />;
      case 'retouches':
        return <SalonRetouches currentUser={currentUser} onOpenChat={handleGoToChat} />;
      case 'salon-clientes':
        return <SalonClients currentUser={currentUser} />;
      case 'pos':
        return <SalonPOS />;
      case 'inventario':
        return <SalonProducts />;
      case 'liquidaciones':
        return <SalonLiquidations />;
      case 'clients':
        return (
          <ClientsList 
            clients={clients} 
            totalClients={totalClients}
            currentPage={clientsPage}
            onPageChange={setClientsPage}
            onSearchChange={setClientsSearch}
            onFiltersChange={(f: any) => setClientsFilters((prev: any) => ({ ...prev, ...f }))}
            onDeleteClient={handleDeleteClient} 
            userRole={currentUser.role} 
            userName={currentUser.name} 
            onChat={handleGoToChat} 
          />
        );
      case 'leads':
        return (
          <LeadPipeline 
            leads={leads} 
            totalLeads={totalLeads}
            currentPage={leadsPage}
            onPageChange={setLeadsPage}
            onSearchChange={setLeadsSearch}
            onFiltersChange={(f: any) => setLeadsFilters((prev: any) => ({ ...prev, ...f }))}
            staff={staff} 
            onUpdateStatus={handleUpdateLeadStatus} 
            onEditLead={(l) => handleOpenFullService(l.clientPhone, l)} 
            onChat={handleGoToChat} 
            currentUser={currentUser} 
          />
        );
      case 'deals':
        return (
          <BusinessDeals 
            services={services} 
            totalServices={totalServices}
            currentPage={servicesPage}
            onPageChange={setServicesPage}
            onSearchChange={setServicesSearch}
            onFiltersChange={(f: any) => setServicesFilters((prev: any) => ({ ...prev, ...f }))}
            staff={staff} 
            onUpdateStatus={handleUpdateDealStatus} 
            onEditService={(s) => { setEditingService(s); setIsServiceFormOpen(true); }} 
            onChat={handleGoToChat} 
            currentUser={currentUser} 
          />
        );
      case 'audit':
        return <AuditModule leads={leads} services={services} onRefresh={fetchData} />;
      case 'inbox':
        return (
          <ChatInbox 
            conversations={chats} 
            staff={staff} 
            currentUser={currentUser} 
            readOnly={['operator', 'estilista', 'manicurista'].includes(currentUser.role)}
            onLocalMessage={handleLocalMessage} 
            onOpenService={handleOpenFullService} 
            onUpdateStatus={handleUpdateLeadStatus} 
            preselectedPhone={preselectedChatPhone}
            onClearPreselection={() => setPreselectedChatPhone(null)}
          />
        );
      case 'wa-channels':
        return <WhatsAppChannels currentUser={currentUser} />;
      case 'branding':
        return currentUser.role === 'admin' ? <BrandingSettings /> : <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
      case 'ajustes':
        return currentUser.role === 'admin' ? <SalonSettings /> : <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
      case 'system-status':
        return currentUser.role === 'admin' ? <SystemStatus /> : <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
      case 'invoices':
        // v5.2 B6: el vendedor (advisor) factura y cobra; anular, export
        // DIAN y la configuración siguen siendo solo admin (dentro de la
        // vista y en el servidor).
        return (currentUser.role === 'admin' || currentUser.role === 'advisor') ? <Invoices currentUser={currentUser} /> : <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
      // (case 'services' eliminado en la auditoría v1.1: ServiceList era
      // inalcanzable — ningún menú lo abría. Los servicios del salón se
      // gestionan en Catálogo de servicios.)
      case 'team':
        return <SalonTeam currentUser={currentUser} />;
      default:
        return <Dashboard currentUser={currentUser} staff={staff} onNavigate={setCurrentView} />;
    }
  };

  const isOperator = currentUser.role === 'operator';

  return (
    <>
      <Layout 
        currentView={currentView} 
        onNavigate={setCurrentView} 
        currentUser={currentUser} 
        onLogout={handleLogout}
      >
        <AnimatePresence mode="wait">
          <motion.div
            key={currentView + (isLoading ? '-loading' : '')}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="h-full"
          >
            {renderView()}
          </motion.div>
        </AnimatePresence>

        {isServiceFormOpen && (
          <ServiceForm 
            initialData={editingService} 
            staff={staff} 
            onSave={handleSaveService} 
            onCancel={() => { setIsServiceFormOpen(false); setEditingService(null); setPrefillData(null); }} 
            onChat={handleGoToChat}
            prefillClient={prefillData}
            userRole={currentUser.role}
          />
        )}
      </Layout>

      {/* AUDITORÍA v1.1: CapacityWidget consulta /api/availability del CRM de limpieza; no se muestra en salones (salonId) ni a operadores. */}
      {!isOperator && !currentUser.salonId && <CapacityWidget />}

      <div className="fixed top-20 right-6 z-[250] space-y-3 pointer-events-none">
         {activeAlarms.map(alarm => (
            <div 
              key={alarm.id}
              className="pointer-events-auto bg-slate-900 text-white p-5 rounded-[2rem] shadow-2xl border-2 border-red-500 flex items-center gap-4 animate-in slide-in-from-right duration-500 w-80 relative overflow-hidden"
            >
               <div className="absolute top-0 right-0 w-24 h-24 bg-red-500/10 blur-2xl rounded-full" />
               <div className="bg-red-500 p-3 rounded-2xl animate-bounce shadow-lg shadow-red-500/20">
                  <BellRing className="w-6 h-6" />
               </div>
               <div className="flex-1">
                  <p className="text-[9px] font-black uppercase text-red-400 tracking-widest mb-1">Alarma Programada</p>
                  <p className="text-sm font-black leading-tight mb-1">{alarm.title}</p>
                  <p className="text-[10px] font-bold text-slate-400">{alarm.client_name}</p>
                  <button 
                    onClick={() => handleCompleteAlarm(alarm.id, alarm.client_phone)}
                    className="mt-3 flex items-center gap-2 text-[9px] font-black uppercase text-emerald-400 hover:text-emerald-300 transition-colors"
                  >
                    Atender ahora <ChevronRight className="w-3 h-3" />
                  </button>
               </div>
               <button 
                 onClick={async () => { await apiFetch(`/api/reminders/${alarm.id}/complete`, { method: 'POST' }); fetchData(); }}
                 className="p-1 hover:bg-white/10 rounded-lg text-slate-500 self-start"
               >
                  <X className="w-4 h-4" />
               </button>
            </div>
         ))}
      </div>

      <AnimatePresence>
        {showToast && (
          <motion.div 
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 50, scale: 0.9 }}
            className="fixed top-6 right-6 z-[200]"
          >
             <div 
               onClick={() => { setShowToast(false); }}
               className={`bg-slate-900 text-white p-5 rounded-2xl shadow-2xl border flex items-center gap-4 cursor-pointer hover:bg-slate-800 transition-all active:scale-95 ${
                 toastMessage.type === 'success' ? 'border-emerald-500/50' : 
                 toastMessage.type === 'error' ? 'border-red-500/50' : 'border-white/10'
               }`}
             >
                <div className={`p-2.5 rounded-xl shadow-lg ${
                  toastMessage.type === 'success' ? 'bg-emerald-600' : 
                  toastMessage.type === 'error' ? 'bg-red-600' : 'bg-brand-600'
                }`}>
                   {toastMessage.type === 'error' ? <AlertCircle className="w-6 h-6" /> : 
                    toastMessage.type === 'success' ? <CheckCircle2 className="w-6 h-6" /> : 
                    <MessageSquare className="w-6 h-6" />}
                </div>
                <div>
                   <p className={`text-[10px] font-black uppercase tracking-widest ${
                     toastMessage.type === 'success' ? 'text-emerald-400' : 
                     toastMessage.type === 'error' ? 'text-red-400' : 'text-brand-400'
                   }`}>{toastMessage.title}</p>
                   <p className="text-sm font-bold">{toastMessage.description}</p>
                   <p className="text-[10px] text-slate-400 mt-1 uppercase">Toca para abrir</p>
                </div>
                <button 
                  onClick={(e) => { e.stopPropagation(); setShowToast(false); }}
                  className="p-1 hover:bg-white/10 rounded-lg text-slate-500"
                >
                   <X className="w-4 h-4" />
                </button>
             </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
