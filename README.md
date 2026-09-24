# AbastFlow — Sistema de Abastecimento

> Versão genérica/sanitizada, sem dados ou identidade de nenhuma empresa real. Todos os e-mails e domínios de exemplo usam `empresaexemplo.com.br`.

Sistema de gestão de abastecimento de frota de veículos: solicitação de combustível/bombonas pelos motoristas, aprovação por supervisores, controle de preços e postos, transferências entre bases, relatórios por localidade/veículo e geração automática de comprovantes em PDF, com upload para o SharePoint.

## Stack

- **Backend:** Node.js + Express + PostgreSQL (`pg`), autenticação via JWT e Microsoft OAuth2, geração de PDF com `pdfkit`
- **Frontend:** HTML/CSS/JS puro (sem framework)
- **Integrações:** Microsoft Graph API / OAuth2 (login SSO e SharePoint), e-mail de notificação
- **Deploy:** Render (`render.yaml`)

## Funcionalidades

- Solicitação de abastecimento (combustível ou bombona/carote) pelos motoristas
- Aprovação de solicitações por supervisores, com controle de acesso por e-mail/domínio corporativo
- Cadastro de veículos, postos e preços de combustível
- Transferências de combustível entre bases/localidades
- Relatórios por veículo, motorista e localidade
- Geração automática de comprovante em PDF e upload para o SharePoint
- Notificação automática por e-mail para gestores

## Configuração

1. Backend:
   ```bash
   cd backend
   npm install
   cp .env.example .env   # preencha com seus próprios valores
   npm start
   ```
2. Frontend:
   ```bash
   cd frontend
   npm install
   npm run dev
   ```
3. Em `frontend/app.js`, configure `window.AZURE_TENANT_ID` e `window.AZURE_CLIENT_ID` (ou substitua os placeholders `SEU_AZURE_TENANT_ID` / `SEU_AZURE_CLIENT_ID`) pelos IDs do seu app registrado no Azure AD.

## Estrutura do projeto

```
backend/    → API Node/Express, autenticação e integrações (SharePoint, e-mail, PDF)
frontend/   → páginas HTML/CSS/JS do sistema
```

## Variáveis de ambiente

Veja `backend/.env.example` para a lista completa (banco de dados, JWT, Azure AD, SharePoint, e-mail).

## Licença

Projeto pessoal para fins de portfólio.
