/** Small browser-only catalog. Importing the full Desktop locale bundles into main
 * would turn this Projects-only M0 view into an unnecessary multi-megabyte seam. */
export const WEB_LOCAL_MESSAGES = Object.freeze({
  en: {
    title: 'CoS Web Local · Read only', readonly: 'READ ONLY',
    intro: 'This is a local browser view, not full Desktop parity.', projects: 'Projects',
    empty: 'No local projects recorded.', limited: 'Showing the first 50 projects only.',
    refresh: 'Refresh current data',
    unavailable: 'Send, Stop, Workers, files, terminal and remote access are unavailable here.'
  },
  de: {
    title: 'CoS Web Local · Nur Lesen', readonly: 'NUR LESEN',
    intro: 'Dies ist eine lokale Browseransicht, nicht die vollständige Desktop-Anwendung.', projects: 'Projekte',
    empty: 'Keine lokalen Projekte gespeichert.', limited: 'Es werden nur die ersten 50 Projekte angezeigt.',
    refresh: 'Aktuelle Daten neu laden',
    unavailable: 'Senden, Stopp, Worker, Dateien, Terminal und Fernzugriff sind hier nicht verfügbar.'
  },
  es: {
    title: 'CoS Web Local · Solo lectura', readonly: 'SOLO LECTURA',
    intro: 'Esta es una vista local en el navegador, no la aplicación de escritorio completa.', projects: 'Proyectos',
    empty: 'No hay proyectos locales guardados.', limited: 'Solo se muestran los primeros 50 proyectos.',
    refresh: 'Actualizar datos',
    unavailable: 'Enviar, detener, agentes, archivos, terminal y acceso remoto no están disponibles aquí.'
  },
  fr: {
    title: 'CoS Web Local · Lecture seule', readonly: 'LECTURE SEULE',
    intro: 'Ceci est une vue locale dans le navigateur, pas l’application de bureau complète.', projects: 'Projets',
    empty: 'Aucun projet local enregistré.', limited: 'Seuls les 50 premiers projets sont affichés.',
    refresh: 'Actualiser les données',
    unavailable: 'L’envoi, l’arrêt, les agents, les fichiers, le terminal et l’accès à distance ne sont pas disponibles ici.'
  },
  ja: {
    title: 'CoS Web Local · 閲覧専用', readonly: '閲覧専用',
    intro: 'これはローカルのブラウザー表示であり、デスクトップ版の全機能は利用できません。', projects: 'プロジェクト',
    empty: 'ローカルのプロジェクトはありません。', limited: '先頭の50件のプロジェクトのみ表示しています。',
    refresh: '現在のデータを更新',
    unavailable: '送信、停止、ワーカー、ファイル、ターミナル、リモートアクセスはここでは利用できません。'
  },
  ko: {
    title: 'CoS Web Local · 읽기 전용', readonly: '읽기 전용',
    intro: '이 화면은 로컬 브라우저 보기이며 데스크톱의 모든 기능을 제공하지 않습니다.', projects: '프로젝트',
    empty: '저장된 로컬 프로젝트가 없습니다.', limited: '처음 50개 프로젝트만 표시합니다.',
    refresh: '현재 데이터 새로고침',
    unavailable: '전송, 중지, 워커, 파일, 터미널, 원격 접속은 여기에서 사용할 수 없습니다.'
  },
  'pt-BR': {
    title: 'CoS Web Local · Somente leitura', readonly: 'SOMENTE LEITURA',
    intro: 'Esta é uma visualização local no navegador, não o aplicativo completo para desktop.', projects: 'Projetos',
    empty: 'Nenhum projeto local registrado.', limited: 'Exibindo apenas os primeiros 50 projetos.',
    refresh: 'Atualizar dados',
    unavailable: 'Enviar, Parar, Workers, arquivos, terminal e acesso remoto não estão disponíveis aqui.'
  },
  'pt-PT': {
    title: 'CoS Web Local · Apenas leitura', readonly: 'APENAS LEITURA',
    intro: 'Esta é uma vista local no navegador, não a aplicação completa para computador.', projects: 'Projetos',
    empty: 'Não há projetos locais registados.', limited: 'São apresentados apenas os primeiros 50 projetos.',
    refresh: 'Atualizar dados',
    unavailable: 'Enviar, Parar, trabalhadores, ficheiros, terminal e acesso remoto não estão disponíveis aqui.'
  },
  ru: {
    title: 'CoS Web Local · Только чтение', readonly: 'ТОЛЬКО ЧТЕНИЕ',
    intro: 'Это локальный просмотр в браузере, а не полный набор функций настольного приложения.', projects: 'Проекты',
    empty: 'Локальные проекты не найдены.', limited: 'Показаны только первые 50 проектов.',
    refresh: 'Обновить данные',
    unavailable: 'Отправка, остановка, воркеры, файлы, терминал и удалённый доступ здесь недоступны.'
  },
  tr: {
    title: 'CoS Web Local · Salt okunur', readonly: 'SALT OKUNUR',
    intro: 'Bu, yerel tarayıcı görünümüdür; masaüstü uygulamasının tüm özelliklerini içermez.', projects: 'Projeler',
    empty: 'Kayıtlı yerel proje yok.', limited: 'Yalnızca ilk 50 proje gösteriliyor.',
    refresh: 'Verileri yenile',
    unavailable: 'Gönderme, durdurma, çalışanlar, dosyalar, terminal ve uzaktan erişim burada kullanılamaz.'
  },
  vi: {
    title: 'CoS Web Local · Chỉ đọc', readonly: 'CHỈ ĐỌC',
    intro: 'Đây là giao diện trình duyệt cục bộ, chưa có đầy đủ chức năng như ứng dụng Desktop.', projects: 'Dự án',
    empty: 'Chưa có dự án cục bộ nào.', limited: 'Chỉ hiển thị 50 dự án đầu tiên.',
    refresh: 'Làm mới dữ liệu',
    unavailable: 'Gửi, Dừng, Workers, tệp, Terminal và truy cập từ xa chưa khả dụng ở đây.'
  },
  'zh-CN': {
    title: 'CoS Web Local · 只读', readonly: '只读',
    intro: '这是本地浏览器视图，尚不具备桌面应用的全部功能。', projects: '项目',
    empty: '暂无本地项目。', limited: '仅显示前 50 个项目。',
    refresh: '刷新当前数据',
    unavailable: '此处暂不支持发送、停止、工作线程、文件、终端及远程访问。'
  },
  'zh-TW': {
    title: 'CoS Web Local · 唯讀', readonly: '唯讀',
    intro: '這是本機瀏覽器檢視，尚未具備桌面應用程式的完整功能。', projects: '專案',
    empty: '尚無本機專案。', limited: '僅顯示前 50 個專案。',
    refresh: '重新整理資料',
    unavailable: '此處尚不支援傳送、停止、工作者、檔案、終端機及遠端存取。'
  }
});

for (const entry of Object.values(WEB_LOCAL_MESSAGES)) Object.freeze(entry);

/** Only a shipped locale code may reach the HTML lang attribute or text lookup. */
export function webLocalMessagesFor(requested) {
  const tag = typeof requested === 'string' ? requested.trim().replace(/_/g, '-').toLowerCase() : '';
  let language;
  if (tag === 'pt-pt' || tag.startsWith('pt-pt-')) language = 'pt-PT';
  else if (tag === 'pt' || tag.startsWith('pt-')) language = 'pt-BR';
  else if (/^zh-(?:tw|hk|mo|hant)(?:-|$)/.test(tag)) language = 'zh-TW';
  else if (tag === 'zh' || tag.startsWith('zh-')) language = 'zh-CN';
  else language = tag.split('-')[0];
  if (!Object.hasOwn(WEB_LOCAL_MESSAGES, language)) language = 'en';
  return { language, strings: WEB_LOCAL_MESSAGES[language] };
}
