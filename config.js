// SITIO DE PRUEBAS: apunta al proyecto AISLADO (sqfobtlxvddmijafttog). No usar con datos reales.
// Configuración de la nube (Supabase).
// La clave "publishable" es pública por diseño: la seguridad la da el SQL (RLS), no ocultar esta clave.
// NUNCA pegues aquí la "secret key" ni la "service_role key".
window.PC_CONFIG = {
  SUPABASE_URL: 'https://sqfobtlxvddmijafttog.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_y8ETQR0KeEF-zHCLYMQvFQ_tqr0ktvC',
  // Clave PÚBLICA para los avisos al celular (la privada va solo en Supabase, nunca aquí).
  VAPID_PUBLIC_KEY: 'BIX-XN_qaw2m2XXGcItVDNYWMJDCA_SQGLRdECX_jA5l0vwvqE2qTBM_DY_wpSdNnt9macgTAofBAqsAdP6WOow',
  // Enlace para que te pidan activar un plan, ej. 'https://wa.me/519XXXXXXXX'. Vacío = se oculta el botón.
  CONTACT_URL: '',
  // Redes sociales: pega el enlace completo (empieza con https://). Vacío = no se muestra.
  INSTAGRAM_URL: 'https://www.instagram.com/plataclara.app',
  FACEBOOK_URL: 'https://www.facebook.com/share/19rUz3jHFN/',
  TIKTOK_URL: 'https://www.tiktok.com/@plataclara.app',
  YOUTUBE_URL: ''
};
