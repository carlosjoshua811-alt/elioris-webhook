// ELIORIS AI — Webhook Server
// Liga WhatsApp Business API <-> Supabase <-> Claude API

const express = require("express");
const app = express();
app.use(express.json());

// ==============================
// VARIÁVEIS DE AMBIENTE (configuradas no serviço de hospedagem)
// ==============================
const {
  VERIFY_TOKEN,           // token que tu escolhes, usado na verificação do webhook na Meta
  WHATSAPP_TOKEN,         // token de acesso da API do WhatsApp (Meta)
  PHONE_NUMBER_ID,        // Phone Number ID (ex: 1165121880025489)
  SUPABASE_URL,           // ex: https://uropuzzucbxhyaxhxsky.supabase.co
  SUPABASE_ANON_KEY,      // chave pública do Supabase
  ANTHROPIC_API_KEY,      // chave sk-ant-... da Anthropic
} = process.env;

// ==============================
// 1. VERIFICAÇÃO DO WEBHOOK (Meta chama isto uma vez, ao configurar)
// ==============================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso.");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ==============================
// 2. RECEBER MENSAGENS (Meta chama isto sempre que um cliente escreve)
// ==============================
app.post("/webhook", async (req, res) => {
  // Responde já 200 pra Meta não reenviar o mesmo evento
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) return; // pode ser um evento de status (entregue/lido), ignoramos

    const from = message.from; // número do cliente
    const text = message.text?.body;
    const displayPhoneNumberId = value.metadata.phone_number_id;

    if (!text) return; // por agora só tratamos mensagens de texto

    console.log(`Mensagem recebida de ${from}: ${text}`);

    // 1. Buscar dados da empresa no Supabase (pelo phone_number_id do WhatsApp)
    const empresa = await getEmpresaPorWhatsapp(displayPhoneNumberId);
    if (!empresa) {
      console.error("Empresa não encontrada para este número.");
      return;
    }

    const servicos = await supabaseSelect(
      "servicos",
      `empresa_id=eq.${empresa.id}&ativo=eq.true&select=*`
    );
    const regrasArr = await supabaseSelect(
      "regras_negocio",
      `empresa_id=eq.${empresa.id}&select=*`
    );
    const regras = regrasArr[0];

    // 2. Buscar histórico recente da conversa (para dar contexto à Claude)
    const historico = await getOuCriarConversa(empresa.id, from);

    // 3. Montar o system prompt dinamicamente
    const systemPrompt = montarSystemPrompt(empresa, servicos, regras);

    // 4. Chamar a Claude
    const respostaClaude = await chamarClaude(systemPrompt, historico, text);

    // 5. Guardar as mensagens no Supabase
    await guardarMensagem(historico.conversaId, "cliente", text);
    await guardarMensagem(historico.conversaId, "elioris", respostaClaude);

    // 6. Enviar a resposta de volta pro WhatsApp
    await enviarMensagemWhatsapp(from, respostaClaude);
  } catch (err) {
    console.error("Erro ao processar mensagem:", err);
  }
});

// ==============================
// FUNÇÕES AUXILIARES
// ==============================

async function fetchComRetry(url, options, tentativas = 3) {
  for (let i = 0; i < tentativas; i++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || (res.status < 500 && res.status !== 522)) {
        return res;
      }
      console.warn(`Tentativa ${i + 1} falhou com status ${res.status}, a tentar de novo...`);
    } catch (err) {
      console.warn(`Tentativa ${i + 1} deu erro de rede: ${err.message}, a tentar de novo...`);
    }
    // espera crescente entre tentativas: 500ms, 1000ms, 1500ms...
    await new Promise((resolve) => setTimeout(resolve, 500 * (i + 1)));
  }
  // última tentativa, deixa o erro passar se ainda falhar
  return fetch(url, options);
}

async function supabaseSelect(table, query) {
  const res = await fetchComRetry(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Erro ao buscar ${table}: ${res.status}`);
  return res.json();
}

async function supabaseInsert(table, body) {
  const res = await fetchComRetry(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Erro ao inserir em ${table}: ${res.status}`);
  return res.json();
}

async function getEmpresaPorWhatsapp(phoneNumberId) {
  // Nota: whatsapp_numero na tabela empresas deve corresponder ao Phone Number ID
  // ou a um campo dedicado. Aqui assumimos que cadastraste o Phone Number ID
  // no campo whatsapp_numero da tabela `empresas`.
  const empresas = await supabaseSelect(
    "empresas",
    `whatsapp_numero=eq.${phoneNumberId}&select=*`
  );
  return empresas[0] || null;
}

async function getOuCriarConversa(empresaId, clienteTelefone) {
  let conversas = await supabaseSelect(
    "conversas",
    `empresa_id=eq.${empresaId}&cliente_telefone=eq.${clienteTelefone}&status=eq.aberta&select=*&order=iniciada_em.desc&limit=1`
  );

  let conversaId;
  let mensagensAnteriores = [];

  if (conversas.length > 0) {
    conversaId = conversas[0].id;
    const mensagens = await supabaseSelect(
      "mensagens",
      `conversa_id=eq.${conversaId}&select=*&order=criado_em.asc&limit=20`
    );
    mensagensAnteriores = mensagens.map((m) => ({
      role: m.remetente === "cliente" ? "user" : "assistant",
      content: m.conteudo,
    }));
  } else {
    const nova = await supabaseInsert("conversas", {
      empresa_id: empresaId,
      cliente_telefone: clienteTelefone,
      canal: "whatsapp",
      status: "aberta",
    });
    conversaId = nova[0].id;
  }

  return { conversaId, mensagensAnteriores };
}

async function guardarMensagem(conversaId, remetente, conteudo) {
  await supabaseInsert("mensagens", {
    conversa_id: conversaId,
    remetente,
    conteudo,
  });
}

async function chamarClaude(systemPrompt, historico, novaMensagem) {
  const messages = [
    ...historico.mensagensAnteriores,
    { role: "user", content: novaMensagem },
  ];

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    }),
  });

  const data = await response.json();

  if (!response.ok || data.error) {
    console.error("ERRO DA API CLAUDE:", JSON.stringify(data));
    return "Desculpa, houve um problema. A equipa vai responder em breve.";
  }

  const textBlocks = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  return textBlocks || "Desculpa, houve um problema. A equipa vai responder em breve.";
}

async function enviarMensagemWhatsapp(to, texto) {
  await fetch(
    `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        text: { body: texto },
      }),
    }
  );
}

function montarSystemPrompt(empresa, servicos, regras) {
  const categorias = [...new Set(servicos.map((s) => s.categoria))];
  const servicosPorCategoria = categorias
    .map((cat) => {
      const itens = servicos.filter((s) => s.categoria === cat);
      const linhas = itens
        .map((s) => {
          const preco = s.preco_fixo
            ? `${s.preco_min} Kz`
            : s.preco_max
            ? `${s.preco_min} – ${s.preco_max} Kz`
            : `a partir de ${s.preco_min} Kz`;
          const obs = s.observacoes ? ` (${s.observacoes})` : "";
          return `- ${s.nome}: ${preco} ${s.unidade}${obs}`;
        })
        .join("\n");
      return `${cat}:\n${linhas}`;
    })
    .join("\n\n");

  return `Você é a ${empresa.nome_assistente}, da ${empresa.cargo_assistente} da ${empresa.nome_marca}, uma gráfica em ${empresa.cidade}, ${empresa.pais}.

TOM: Fala exatamente como um atendente humano angolano experiente da ${empresa.nome_marca} — caloroso, pessoal, acolhedor, com expressões do dia a dia de Luanda. Nunca soa como robô. Usa "Kz" para Kwanzas. NUNCA usa emojis em nenhuma mensagem.

FORMATO DAS MENSAGENS: Escreve como alguém realmente escreve no WhatsApp — frases curtas, separadas por quebras de linha (\\n), nunca um parágrafo único e denso. Cada ideia numa linha ou bloco curto, com uma linha em branco entre blocos quando fizer sentido, para ficar fácil de ler no telemóvel.

APRESENTAÇÃO: Quando se apresentar (na primeira mensagem ou quando o cliente perguntar o nome), a apresentação deve ser calorosa e completa, mas dividida em linhas curtas, por exemplo:

"Olá, seja muito bem-vindo à ${empresa.nome_marca}!

Eu sou a ${empresa.nome_assistente}, faço parte da ${empresa.cargo_assistente}. É um belo prazer falar contigo.

Estou aqui para te ajudar com informações sobre os nossos serviços e orçamentos. Como posso ajudar?"

Sempre soando genuinamente feliz em atender, próxima e acolhedora, nunca fria ou seca. Não te apresentes como "IA" espontaneamente. Se perguntarem diretamente, responde com honestidade, sem fingir ser humano.

TABELA DE PREÇOS (Kz):

${servicosPorCategoria}

REGRA SOBRE PREÇOS VARIÁVEIS: para faixas de preço, nunca feches valor exato — dá a faixa e diz que a equipa confirma o orçamento exato.

REGRAS DE NEGÓCIO:
- Prazo de produção: ${regras.prazo_producao}
- Pagamento: ${regras.condicoes_pagamento}. Métodos: ${regras.metodos_pagamento}. Dados bancários (só quando o cliente confirmar o pedido): Banco ${regras.banco}, titular ${regras.titular_conta}, IBAN ${regras.iban}.
- Contacto direto: ${regras.contacto_alternativo_1} ou ${regras.contacto_alternativo_2}.
- Sempre pergunta: tipo de serviço, quantidade/tamanho, prazo desejado, se tem arte pronta.

QUANDO ESCALAR PARA HUMANO: pedido de desconto, reclamação, encomenda muito grande/customizada, instalação/manutenção de letreiros, cliente insiste em falar com pessoa, ou qualquer dúvida sem certeza. Aviso vai para: ${regras.responsavel_escalonamento}.

Nunca invente informação fora deste catálogo.`;
}

// ==============================
// INICIAR SERVIDOR
// ==============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ELIORIS webhook rodando na porta ${PORT}`));
