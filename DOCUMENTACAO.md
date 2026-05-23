# ZEUS SAAS - WHATSAPP API GATEWAY
**Documentação Oficial e Manual de Integração (v1.1.0)**

Bem-vindo à documentação oficial do **Zeus SaaS WhatsApp API Gateway**. Este manual descreve detalhadamente como interagir com o nosso motor multitenant de envios, desenhado para suportar alta disponibilidade, gestão de filas de mensagens e operações à prova de falhas.

---

## 📌 Sumário
1. [Visão Geral e Arquitetura](#1-visão-geral-e-arquitetura)
2. [Autenticação e Segurança](#2-autenticação-e-segurança)
3. [Administração Master (Gestão de Tenants)](#3-administração-master-gestão-de-tenants)
4. [Integração de Clientes (Sessão e Mensageria)](#4-integração-de-clientes-sessão-e-mensageria)
5. [Boas Práticas e Anti-Ban](#5-boas-práticas-e-anti-ban)

---

## 1. Visão Geral e Arquitetura

A API foi projetada num modelo **Multitenant**, o que significa que uma única infraestrutura suporta múltiplos clientes de forma totalmente isolada. 
* O processamento de envio de mensagens é assíncrono e passa por uma **Fila de Disparo (Queue)**, evitando o bloqueio da API e simulando o comportamento humano.
* A API fornece documentação interativa nativa via Swagger, acessível no endpoint `/api-docs` (protegida por Master Key).

**Base URLs:**
* **Produção:** `http://3.144.93.205:3000/api/v1`
* **Desenvolvimento:** `http://localhost:3000/api/v1`

---

## 2. Autenticação e Segurança

O sistema utiliza dois níveis estritos de autenticação baseados no cabeçalho HTTP:

### Nível 1: Master Key (Administração do SaaS)
Usada exclusivamente pelo proprietário do sistema para criar, suspender ou excluir clientes.
* **Header:** `x-master-key: <SUA_MASTER_KEY>` ou `Authorization: Bearer <SUA_MASTER_KEY>`

### Nível 2: Tenant API Key (Uso do Cliente)
Chave gerada automaticamente na criação de um Tenant (ex: `sk_live_wa_0a4f...`). Usada pelos clientes para disparar mensagens e gerir a própria sessão.
* **Header:** `Authorization: Bearer <TENANT_API_KEY>`

---

## 3. Administração Master (Gestão de Tenants)

⚠️ *Todas as rotas desta seção exigem a **Master Key** no cabeçalho.*

### 3.1. Criar Nova Instância de Tenant
Cria um ambiente isolado para um novo cliente. O sistema gera automaticamente um `tenantId` no formato `LLLLDDAAAAMM` (Letras Aleatórias + Dia + Ano + Mês) e uma API Key segura.

* **Rota:** `POST /admin/tenants`
* **Request Body:** *(Vazio)*
* **Resposta de Sucesso (200 OK):**
```json
{
    "success": true,
    "message": "Instância para o tenant 'XPTK23202605' criada com sucesso!",
    "tenantId": "XPTK23202605",
    "apiKey": "sk_live_wa_a1b2c3d4e5f6g7h8i9j0"
}
```

### 3.2. Suspender / Reativar Instância

Bloqueia o acesso de um cliente por inadimplência ou violação de regras. Se suspenso, a conexão ativa do WhatsApp é derrubada instantaneamente.

* **Rota:** `POST /admin/tenants/{tenantId}/suspend`
* **Request Body:**

```json
{
    "action": "suspend" // Use "suspend" ou "reactivate"
}
```

### 3.3. Excluir Instância (Permanente)

Exclui todos os registos do cliente no banco de dados e limpa as sessões em memória. **Ação irreversível.**

* **Rota:** `DELETE /admin/tenants/{tenantId}`
* **Response (200 OK):** `{"success": true, "message": "Instância 'XPTK23202605' foi permanentemente excluída."}`

### 3.4. Emitir Extrato de Logs

Gera e faz o download de um relatório `.txt` auditável contendo o estado atual do banco de dados e da memória para a instância selecionada.

* **Rota:** `GET /admin/tenants/{tenantId}/logs`
* **Response:** Arquivo `log_{tenantId}.txt` para download.

---

## 4. Integração de Clientes (Sessão e Mensageria)

⚠️ *As rotas abaixo exigem a **Tenant API Key** gerada no momento da criação da conta.*

### 4.1. Conectar via QR Code ou PIN (Painel HTML)

O sistema fornece uma interface web limpa pronta a ser apresentada aos clientes finais num iframe, permitindo que eles leiam o QR Code ou solicitem o Código PIN para conectar o WhatsApp.

* **Rota:** `GET /sessions/{tenantId}`
* **Headers:** `Authorization: Bearer <TENANT_API_KEY>`
* **Resposta:** HTML contendo o QR Code dinâmico e o formulário de PIN.

### 4.2. Solicitar Código PIN via API

Permite que você integre a geração de PIN diretamente no seu próprio front-end (sem usar o nosso HTML).

* **Rota:** `POST /sessions/{tenantId}/pairing-code`
* **Request Body:**

```json
{
    "phoneNumber": "5541999999999" // Número com DDI e DDD, sem espaços
}
```

* **Resposta de Sucesso (200 OK):**

```json
{
    "success": true,
    "code": "A1B2C3D4"
}
```

### 4.3. Disparar Mensagens (Texto e Mídia)

Adiciona uma mensagem à fila de disparo da instância. O motor de filas encarrega-se do agendamento, processamento de ficheiros e auditoria geográfica (IP Tracker).

* **Rota:** `POST /sessions/{tenantId}/messages`
* **Request Body:**

```json
{
    "number": "5541999999999",
    "text": "Olá! Esta é uma mensagem de teste enviada pela API.",
    "mediaUrl": "https://meusite.com/arquivo.pdf", // Opcional
    "mediaType": "document" // Opcional (image, video, audio, document)
}
```

* **Resposta de Sucesso (200 OK):**

```json
{
    "success": true,
    "message": "Mensagem adicionada com sucesso à fila de envio auditada.",
    "jobId": "12345"
}
```

### 4.4. Listar Status das Instâncias

Mostra todas as instâncias existentes, realizando um cruzamento entre o status no Banco de Dados (ex: `ACTIVE`, `SUSPENDED`) e o status em Memória (ex: `CONNECTED`, `WAITING_QR`).

* **Rota:** `GET /sessions`
* **Response (200 OK):**

```json
[
    {
        "id": "XPTK23202605",
        "status_memoria": "CONNECTED",
        "status_banco": "ACTIVE",
        "apiKey": "sk_live_wa_..."
    }
]
```

### 4.5. Desconectar WhatsApp

Desconecta o telemóvel do cliente do servidor e limpa os caches de sessão associados.

* **Rota:** `DELETE /sessions/{tenantId}`
* **Response:** `{"success": true, "message": "Sessão do tenant 'XPTK23202605' encerrada com sucesso..."}`

---

## 5. Boas Práticas e Anti-Ban

O envio massivo via integrações não oficiais de WhatsApp requer cautela extrema. O **Zeus SaaS** possui mecanismos nativos de proteção, mas o cliente final deve respeitar regras fundamentais:

1. **Aquecimento de Número (Warm-up):** Números novos não devem disparar mais de 50 mensagens no primeiro dia. Escale progressivamente.
2. **Uso da Fila de Mensagens:** A API enfileira mensagens em background (`messageQueue`). Não tente contornar o delay do servidor. O delay protege o seu número de bloqueios sistémicos pela Meta.
3. **Engajamento Bidirecional:** A saúde do número depende das respostas. Solicite confirmações simples (ex: *"Responda OK para continuar"*) antes de disparar links pesados ou PDFs promocionais.
4. **Tratamento de Erros:** Monitore retornos `400` ou `500`. Se uma instância estiver no status `SUSPENDED`, o sistema não injetará mensagens na fila para proteção da carga da infraestrutura master.
