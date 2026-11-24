/* Aplica o tema salvo antes da renderização, para evitar "piscada".
   Arquivo externo porque a Content Security Policy não permite scripts inline. */
(function () {
  var tema;
  try { tema = localStorage.getItem("tema"); } catch (e) {}
  if (tema !== "light" && tema !== "dark") {
    tema = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", tema);
})();
