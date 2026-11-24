/* ==========================================================
   Cultura em Movimento - Interações
   ========================================================== */

document.addEventListener("DOMContentLoaded", () => {
  const header = document.querySelector(".header");
  const navToggle = document.querySelector(".nav-toggle");
  const navLinks = document.getElementById("menu");
  const navAnchors = navLinks.querySelectorAll("a");

  /* ---------- Tema claro / escuro ---------- */
  const themeBtn = document.querySelector(".theme-toggle");
  const root = document.documentElement;

  const applyTheme = (theme) => {
    root.setAttribute("data-theme", theme);
    const label = theme === "light" ? "Ativar tema escuro" : "Ativar tema claro";
    themeBtn.setAttribute("aria-label", label);
    themeBtn.setAttribute("title", label);
  };

  applyTheme(root.getAttribute("data-theme") === "light" ? "light" : "dark");

  themeBtn.addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
    applyTheme(next);
    try {
      localStorage.setItem("tema", next);
    } catch (e) {
      /* armazenamento indisponível: a escolha vale só para esta visita */
    }
  });

  /* ---------- Cabeçalho com sombra ao rolar ---------- */
  const onScroll = () => {
    header.classList.toggle("scrolled", window.scrollY > 40);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- Menu mobile ---------- */
  const setMenu = (open) => {
    navLinks.classList.toggle("is-open", open);
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Fechar menu" : "Abrir menu");
    document.body.style.overflow = open ? "hidden" : "";
  };

  navToggle.addEventListener("click", () => {
    setMenu(!navLinks.classList.contains("is-open"));
  });

  navAnchors.forEach((link) =>
    link.addEventListener("click", () => setMenu(false))
  );

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setMenu(false);
  });

  /* Ao ampliar a janela com o menu aberto, libera a rolagem da página */
  window.matchMedia("(min-width: 769px)").addEventListener("change", (e) => {
    if (e.matches) setMenu(false);
  });

  /* ---------- Revelar elementos ao rolar ---------- */
  const revealEls = document.querySelectorAll(".reveal");

  if ("IntersectionObserver" in window) {
    const revealObserver = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const el = entry.target;
            el.classList.add("is-visible");
            observer.unobserve(el);
            // Remove o atraso após a entrada para não afetar o hover
            setTimeout(() => (el.style.transitionDelay = ""), 1200);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
    );

    revealEls.forEach((el, index) => {
      // Pequeno atraso escalonado para cards que estão lado a lado
      el.style.transitionDelay = `${(index % 3) * 80}ms`;
      revealObserver.observe(el);
    });
  } else {
    revealEls.forEach((el) => el.classList.add("is-visible"));
  }

  /* ---------- Filtro de projetos ---------- */
  const filterButtons = document.querySelectorAll(".filter-btn");
  const projectCards = document.querySelectorAll(".project-card");

  filterButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const filter = btn.dataset.filter;

      filterButtons.forEach((b) => {
        const active = b === btn;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-pressed", String(active));
      });

      projectCards.forEach((card) => {
        const match = filter === "todos" || card.dataset.category === filter;
        card.classList.toggle("is-hidden", !match);
      });
    });
  });

  /* ---------- Formulário de contato (validação no navegador + envio à API) ---------- */
  const form = document.getElementById("contact-form");
  const feedback = form.querySelector(".form-feedback");

  const validators = {
    nome: (v) => (v.trim().length >= 3 ? "" : "Informe seu nome completo."),
    email: (v) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? "" : "Informe um e-mail válido.",
    assunto: (v) => (v ? "" : "Selecione um assunto."),
    mensagem: (v) =>
      v.trim().length >= 10 ? "" : "A mensagem deve ter pelo menos 10 caracteres.",
  };

  const validateField = (field) => {
    const wrapper = field.closest(".field");
    const validator = validators[field.name];
    const message = validator ? validator(field.value) : "";

    wrapper.classList.toggle("has-error", Boolean(message));
    wrapper.querySelector(".error-msg").textContent = message;
    return !message;
  };

  form.querySelectorAll("input, select, textarea").forEach((field) => {
    field.addEventListener("blur", () => validateField(field));
    field.addEventListener("input", () => {
      if (field.closest(".field").classList.contains("has-error")) {
        validateField(field);
      }
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const fields = form.querySelectorAll("input, select, textarea");
    let valid = true;
    let firstInvalid = null;

    fields.forEach((field) => {
      const ok = validateField(field);
      if (!ok) {
        valid = false;
        if (!firstInvalid) firstInvalid = field;
      }
    });

    if (!valid) {
      feedback.className = "form-feedback error";
      feedback.textContent = "Revise os campos destacados.";
      firstInvalid.focus();
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = "Enviando...";
    feedback.className = "form-feedback";
    feedback.textContent = "";

    const payload = Object.fromEntries(new FormData(form).entries());

    const resetForm = () => {
      form.reset();
      form.querySelectorAll(".field").forEach((f) => f.classList.remove("has-error"));
      form.querySelectorAll(".error-msg").forEach((el) => (el.textContent = ""));
    };

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));

      if (response.ok) {
        resetForm();
        feedback.className = "form-feedback success";
        feedback.textContent = result.message || "Mensagem enviada com sucesso!";
      } else if (result.saved) {
        /* A mensagem foi gravada, só o e-mail falhou: limpa o formulário
           para o visitante não reenviar e duplicar o registro. */
        resetForm();
        feedback.className = "form-feedback warning";
        feedback.textContent = result.message;
      } else {
        throw new Error(result.message || "Não foi possível enviar a mensagem.");
      }
    } catch (error) {
      feedback.className = "form-feedback error";
      feedback.textContent = error.message || "Ocorreu um erro. Tente novamente.";
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  });


  /* ---------- Pesquisa de museus e espaços culturais ---------- */
  const museumForm = document.getElementById("museum-search-form");
  const museumResults = document.getElementById("museum-results");
  const museumFeedback = document.getElementById("museum-feedback");

  const setMuseumFeedback = (text, type = "") => {
    museumFeedback.className = type ? `form-feedback ${type}` : "form-feedback";
    museumFeedback.textContent = text;
  };

  const isHttpUrl = (value) => {
    try {
      const u = new URL(value);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch (e) {
      return false;
    }
  };

  const buildMuseumCard = (place) => {
    const article = document.createElement("article");
    article.className = "museum-card";

    if (place.category) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = place.category;
      article.append(tag);
    }

    const title = document.createElement("h3");
    title.textContent = place.name;

    const address = document.createElement("p");
    address.textContent = place.address || "Endereço não informado";

    article.append(title, address);

    [[place.website, "Site oficial"], [place.mapsUrl, "Ver no mapa"]].forEach(([url, label]) => {
      if (!isHttpUrl(url)) return;
      const a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = label;
      article.append(a);
    });

    return article;
  };

  if (museumForm) {
    museumForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const city = museumForm.elements.city.value.trim();
      const button = museumForm.querySelector('button[type="submit"]');

      button.disabled = true;
      button.textContent = "Pesquisando...";
      museumResults.replaceChildren();
      setMuseumFeedback("");

      try {
        const response = await fetch(`/api/museums?city=${encodeURIComponent(city)}`);
        const data = await response.json().catch(() => ({}));

        if (!response.ok) throw new Error(data.message || "Falha na pesquisa.");

        if (!data.places.length) {
          setMuseumFeedback("Nenhum espaço cultural encontrado para essa pesquisa.");
        } else {
          data.places.forEach((place) => museumResults.append(buildMuseumCard(place)));
          setMuseumFeedback(`${data.places.length} resultado(s) encontrado(s).`, "success");
        }
      } catch (error) {
        setMuseumFeedback(error.message || "Falha na pesquisa.", "error");
      } finally {
        button.disabled = false;
        button.textContent = "Buscar espaços";
      }
    });
  }

  /* ---------- Galeria 3D cadastrada pela administração ---------- */
  const experienceResults = document.getElementById("experience-results");

  /* Só aceita incorporação oficial do Sketchfab, mesmo que o dado venha adulterado */
  const isSketchfabEmbed = (value) => {
    try {
      const u = new URL(value);
      return (
        u.protocol === "https:" &&
        u.hostname === "sketchfab.com" &&
        /^\/models\/[a-zA-Z0-9-]+\/embed\/?$/.test(u.pathname)
      );
    } catch (e) {
      return false;
    }
  };

  const showExperienceMessage = (text) => {
    const p = document.createElement("p");
    p.className = "empty-state";
    p.textContent = text;
    experienceResults.replaceChildren(p);
  };

  if (experienceResults) {
    fetch("/api/experiences")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Falha"))))
      .then(({ experiences }) => {
        const valid = (experiences || []).filter((item) => isSketchfabEmbed(item.embedUrl));

        if (!valid.length) {
          showExperienceMessage("As experiências virtuais serão disponibilizadas em breve.");
          return;
        }

        experienceResults.replaceChildren();

        valid.forEach((item) => {
          const card = document.createElement("article");
          card.className = "experience-card";

          const h = document.createElement("h3");
          h.textContent = item.title;

          const p = document.createElement("p");
          p.textContent = item.description || "";

          const frame = document.createElement("iframe");
          frame.className = "experience-frame";
          frame.src = item.embedUrl;
          frame.title = `Experiência 3D: ${item.title}`;
          frame.loading = "lazy";
          frame.allow = "autoplay; fullscreen; xr-spatial-tracking";
          frame.allowFullscreen = true;
          frame.referrerPolicy = "strict-origin-when-cross-origin";

          card.append(h, p, frame);
          experienceResults.append(card);
        });
      })
      .catch(() => showExperienceMessage("Não foi possível carregar as experiências virtuais agora."));
  }

  /* ---------- Ano atual no rodapé ---------- */
  const anoEl = document.getElementById("ano");
  if (anoEl) anoEl.textContent = new Date().getFullYear();
});
