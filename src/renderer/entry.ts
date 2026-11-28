// The two native windows share the exact chat markup and feature implementation.
import './quick-chat.css';
if (new URLSearchParams(location.search).get('surface') === 'quick-chat') {
  document.body.classList.add('compact-chat');
  void import('./quick-chat.js');
} else {
  void import('./main.js');
}
