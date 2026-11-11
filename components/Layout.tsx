
import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  LayoutDashboard,
  CalendarDays,
  Scissors,
  ShoppingBag,
  Package,
  Calculator,
  Store,
  Clock,
  Menu,
  X,
  Droplets,
  Users,
  MessageSquare,
  LogOut,
  Target,
  Briefcase,
  User,
  Smartphone,
  Volume2,
  VolumeX,
  ShieldAlert,
  Palette,
  Activity,
  Receipt,
  Settings
} from 'lucide-react';
import { ViewState, CurrentUser, roleLabel } from '../types';
import { notificationService } from '../utils/NotificationService';
import { getCachedBranding, loadBranding, Branding } from '../lib/branding';
import { apiFetch, setToken } from '../lib/api';

interface LayoutProps {
  currentView: ViewState;
  onNavigate: (view: ViewState) => void;
  children: React.ReactNode;
  currentUser: CurrentUser;
  onLogout: () => void;
}

export const Layout: React.FC<LayoutProps> = ({ currentView, onNavigate, children, currentUser, onLogout }) => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);
  const [isOnline, setIsOnline] = React.useState(currentUser.isOnline ?? true);
  const [isMuted, setIsMuted] = React.useState(notificationService.getMute());
  const [branding, setBranding] = useState<Branding>(getCachedBranding());

  useEffect(() => {
    loadBranding().then(setBranding).catch(() => {});
    const onUpdate = (e: Event) => setBranding((e as CustomEvent).detail);
    window.addEventListener('branding-updated', onUpdate);
    return () => window.removeEventListener('branding-updated', onUpdate);
  }, []);

  const isOperator = currentUser.role === 'operator';

  const handleStatusToggle = async (status: boolean) => {
    setIsOnline(status);
    try {
      await apiFetch('/api/staff/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: currentUser.id, isOnline: status })
      });
    } catch (e) { console.error('Error toggling status', e); }
  };

  const toggleMute = () => {
    const newMute = !isMuted;
    setIsMuted(newMute);
    notificationService.setMute(newMute);
    if (!newMute) {
      notificationService.playSent();
    }
  };

  const handleFullLogout = async () => {
    await handleStatusToggle(false);
    onLogout();
  };

  const getNavItems = () => {
    const items = [];
    const role = currentUser.role;
    
    items.push({ view: 'dashboard', icon: LayoutDashboard, label: 'Dashboard' });
    // SalonOS v1: navegación de salón (los módulos de limpieza heredados
    // — Pipeline, Negocios, Servicios — ya no se muestran en el menú).
    if (role === 'superadmin') {
      items.push({ view: 'salones', icon: Store, label: 'Salones' });
    }
    // AUDITORÍA v1.1: la estilista/manicurista veía Agenda y Clientas en
    // el menú, pero el servidor le devuelve 403 en casi todo lo que hay
    // ahí. Solo Panel y Hoy (sus citas, sus ventas, su comisión).
    if (role === 'admin' || role === 'recepcionista') {
      items.push({ view: 'salon-dashboard', icon: LayoutDashboard, label: 'Panel del salón' });
      items.push({ view: 'hoy', icon: Clock, label: 'Hoy' });
      items.push({ view: 'agenda', icon: CalendarDays, label: 'Agenda' });
      items.push({ view: 'salon-clientes', icon: User, label: 'Clientas' });
    } else if (role === 'estilista' || role === 'manicurista') {
      items.push({ view: 'salon-dashboard', icon: LayoutDashboard, label: 'Panel del salón' });
      items.push({ view: 'hoy', icon: Clock, label: 'Hoy' });
    }
    if (role === 'admin' || role === 'recepcionista') {
      items.push({ view: 'catalogo', icon: Scissors, label: 'Catálogo de servicios' });
      items.push({ view: 'retouches', icon: Activity, label: 'Retoques y seguimiento' });
      items.push({ view: 'pos', icon: ShoppingBag, label: 'Caja / POS' });
      items.push({ view: 'inventario', icon: Package, label: 'Inventario' });
      items.push({ view: 'liquidaciones', icon: Calculator, label: 'Liquidaciones' });
    }

    // v5.2 B5: el operador también ve Mensajes, pero solo en lectura y
    // solo las conversaciones de los clientes de sus servicios asignados
    // (el servidor filtra y el inbox va en modo lectura).
    if (role === 'admin' || role === 'recepcionista' || role === 'advisor' || role === 'sales_agent' || role === 'operator' || role === 'estilista' || role === 'manicurista') {
      items.push({ view: 'inbox', icon: MessageSquare, label: 'Mensajes' });
    }

    if (role === 'superadmin') {
      items.push({ view: 'clients', icon: User, label: 'Base de Clientes' });
      items.push({ view: 'leads', icon: Target, label: 'Pipeline de Ventas' });
    }
    
    // AUDITORÍA v1.1: la recepcionista veía Facturación en el menú pero
    // la vista solo se renderiza para admin/advisor y caía en Dashboard.
    if (role === 'admin' || role === 'advisor') {
      items.push({ view: 'invoices', icon: Receipt, label: 'Facturación' });
    }
    if (role === 'admin') {
      items.push({ view: 'deals', icon: Briefcase, label: 'Negocios' });
      items.push({ view: 'wa-channels', icon: Smartphone, label: 'Canales WhatsApp' });
      items.push({ view: 'branding', icon: Palette, label: 'Personalización' });
      items.push({ view: 'ajustes', icon: Settings, label: 'Ajustes del salón' });
      items.push({ view: 'system-status', icon: Activity, label: 'Estado del Sistema' });
      // MODIFICACIÓN: Resaltado visual para el módulo de auditoría
      items.push({ 
        view: 'audit', 
        icon: ShieldAlert, 
        label: 'Auditoría & Limpieza', 
        isCritical: true 
      });
    }

    // AUDITORÍA v1.1: el superadmin veía Equipo pero GET /api/staff da 403
    // sin contexto de salón en el JWT.
    if (role === 'admin' || role === 'recepcionista') {
      items.push({ view: 'team', icon: Users, label: 'Equipo' });
    }
    return items;
  };

  const NavItem = ({ view, icon: Icon, label, badge, isCritical }: { view: any; icon: any; label: string; badge?: number; isCritical?: boolean }) => (
    <button
      onClick={() => { onNavigate(view); setIsMobileMenuOpen(false); }}
      className={`relative flex items-center justify-between w-full px-4 py-3 mb-1 text-sm font-medium transition-colors rounded-lg ${
        currentView === view 
          ? (isCritical ? 'bg-red-50 text-red-700' : 'bg-brand-50 text-brand-700') 
          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      }`}
    >
      <div className="flex items-center">
        <Icon className={`w-5 h-5 mr-3 ${isCritical ? 'text-red-500' : ''}`} />
        <span className={isCritical ? 'font-black' : ''}>{label}</span>
      </div>
      {badge !== undefined && (
        <div className="relative flex h-5 w-5 items-center justify-center">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-5 w-5 bg-red-500 text-white text-[10px] font-black items-center justify-center shadow-lg shadow-red-500/40 border border-white">
            {badge}
          </span>
        </div>
      )}
    </button>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 relative">
      <AnimatePresence>
        {isMobileMenuOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-40 md:hidden" 
            onClick={() => setIsMobileMenuOpen(false)}
          />
        )}
      </AnimatePresence>

      <aside className={`
        fixed inset-y-0 left-0 w-72 bg-white border-r border-slate-200 z-50 flex flex-col transition-transform duration-300 ease-in-out transform
        ${isMobileMenuOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'}
        md:translate-x-0 md:static md:w-64 md:flex md:flex-col md:z-20
      `}>
        <div className="flex items-center justify-between px-6 h-16 border-b border-slate-100">
          <div className="flex items-center min-w-0">
            {branding.logo_url ? (
              <img src={branding.logo_url} alt={branding.company_name} className="w-8 h-8 object-contain mr-2" />
            ) : (
              <Droplets className="w-8 h-8 text-brand-600 mr-2" />
            )}
            <span className="text-lg font-bold text-slate-800 uppercase tracking-tighter truncate">{branding.company_name}</span>
          </div>
          <button onClick={() => setIsMobileMenuOpen(false)} className="md:hidden p-2 text-slate-400 hover:text-slate-600">
            <X className="w-6 h-6" />
          </button>
        </div>
        
        <nav className="flex-1 px-4 py-6 space-y-2 overflow-y-auto">
          {getNavItems().map((item: any) => <NavItem key={item.view} {...item} />)}
        </nav>

        <div className="p-4 border-t border-slate-100">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-3 overflow-hidden">
              <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-white font-bold bg-brand-600`}>
                {currentUser.name.charAt(0)}
              </div>
              <div className="text-sm truncate">
                <p className="font-medium text-slate-700 truncate">{currentUser.name}</p>
                <p className="text-slate-500 text-xs">{roleLabel(currentUser.role)}</p>
              </div>
            </div>
            <button onClick={handleFullLogout} title="Cerrar Sesión y Desconectar" className="text-slate-400 hover:text-red-500 p-2 transition-colors"><LogOut className="w-4 h-4" /></button>
          </div>
          {/* AUDITORÍA v1.1: volver a superadmin tras entrar a un salón. */}
          {(() => { try { return localStorage.getItem('salonos_superadmin_session') && currentUser.role !== 'superadmin'; } catch { return false; } })() && (
            <button
              className="mt-3 w-full text-xs font-bold text-brand-600 border border-brand-200 rounded-lg px-3 py-2 hover:bg-brand-50"
              onClick={async () => {
                // v1.3: el servidor restaura la cookie de superadmin guardada
                // al entrar al salón (POST /api/salons/exit). Si falla, se
                // usa la sesión guardada en localStorage (flujo viejo).
                try {
                  const r = await apiFetch('/api/salons/exit', { method: 'POST' });
                  const d = await r.json().catch(() => null);
                  if (r.ok && d?.user) {
                    setToken(null);
                    localStorage.setItem('salonos_session', JSON.stringify(d.user));
                    localStorage.removeItem('salonos_superadmin_session');
                    window.location.reload();
                    return;
                  }
                } catch {}
                try {
                  const saved = JSON.parse(localStorage.getItem('salonos_superadmin_session') || 'null');
                  if (!saved?.user) return;
                  if (saved.token) setToken(saved.token); else setToken(null);
                  localStorage.setItem('salonos_session', JSON.stringify(saved.user));
                  localStorage.removeItem('salonos_superadmin_session');
                  window.location.reload();
                } catch {}
              }}
            >← Volver a superadmin</button>
          )}
        </div>
      </aside>

      <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
        <header className="flex items-center justify-between px-6 h-16 bg-white border-b border-slate-200 md:hidden shrink-0 z-30">
          <div className="flex items-center min-w-0">
            {branding.logo_url ? (
              <img src={branding.logo_url} alt={branding.company_name} className="w-7 h-7 object-contain mr-2" />
            ) : (
              <Droplets className="w-7 h-7 text-brand-600 mr-2" />
            )}
            <span className="font-bold text-slate-800 tracking-tight truncate">{branding.company_name}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={toggleMute} className="p-2.5 text-slate-400 hover:bg-slate-50 rounded-xl">
              {isMuted ? <VolumeX className="w-6 h-6" /> : <Volume2 className="w-6 h-6 text-brand-600" />}
            </button>
            <button 
              onClick={() => setIsMobileMenuOpen(true)} 
              className="p-2.5 text-slate-500 bg-slate-50 rounded-xl hover:bg-slate-100 border border-slate-200"
            >
              <Menu className="w-6 h-6" />
            </button>
          </div>
        </header>

        <div className="hidden md:flex h-14 bg-white border-b border-slate-200 px-8 items-center justify-between shrink-0">
           <div className="text-sm text-slate-500 flex items-center gap-4">
              <span>Bienvenido, {currentUser.name}.</span>
              <button onClick={toggleMute} title={isMuted ? "Activar Sonidos" : "Silenciar Sistema"} className="p-1.5 hover:bg-slate-100 rounded-lg transition-colors">
                {isMuted ? <VolumeX className="w-4 h-4 text-slate-400" /> : <Volume2 className="w-4 h-4 text-brand-500" />}
              </button>
           </div>
           <div className="flex items-center gap-6">
              {currentUser.role !== 'operator' && (
                <div className="flex items-center gap-3">
                   <span className={`text-[10px] font-black uppercase tracking-widest transition-colors ${isOnline ? 'text-emerald-500' : 'text-slate-400'}`}>{isOnline ? ((currentUser.role === 'estilista' || currentUser.role === 'manicurista') ? 'Disponible para citas' : 'Disponible') : 'Fuera de Línea'}</span>
                   <button onClick={() => handleStatusToggle(!isOnline)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isOnline ? 'bg-emerald-500' : 'bg-slate-200'}`}><span className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${isOnline ? 'translate-x-6' : 'translate-x-1'}`} /></button>
                </div>
              )}
           </div>
        </div>

        <main className={`flex-1 relative ${currentView === 'inbox' ? 'overflow-hidden flex flex-col' : 'overflow-y-auto p-4 md:p-8'}`}>
          {children}
        </main>
      </div>
    </div>
  );
};
