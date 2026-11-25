import security from 'eslint-plugin-security';
import nounsan from 'eslint-plugin-no-unsanitized';
import globals from 'globals';
// Reglas de alta señal como ERROR. detect-object-injection es muy ruidosa en este código (acceso a objetos con claves
// internas) y se deja en aviso para revisarla, no se oculta.
export default [{
  files: ['build/**/*.js'],
  languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: { ...globals.browser, ...globals.serviceworker } },
  plugins: { security, 'no-unsanitized': nounsan },
  rules: {
    ...security.configs.recommended.rules,
    'security/detect-object-injection': 'warn',
    'no-eval': 'error', 'no-implied-eval': 'error', 'no-new-func': 'error', 'no-script-url': 'error',
    'no-unsanitized/method': 'warn', 'no-unsanitized/property': 'warn'   // 17 usos de innerHTML/document.write revisados a mano: ver informe
  }
}];
