// Light by default. Dark only when the person picks it with the toggle; the choice is kept in this browser. The operating system's setting is ignored on purpose.
(function () {
  var KEY = 'notera.theme';
  function get() { try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; } catch (e) { return 'light'; } }
  function apply(t) {
    document.documentElement.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', t === 'dark' ? '#150B13' : '#3A0F34');
  }
  window.NoteraTheme = {
    get: get,
    set: function (t) { try { localStorage.setItem(KEY, t); } catch (e) { /* private window: the choice lasts until the page closes */ } apply(t); return t; },
    toggle: function () { return this.set(get() === 'dark' ? 'light' : 'dark'); },
  };
  apply(get());
})();
