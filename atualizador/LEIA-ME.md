# Atualizador (versões do GitHub)

Cada servidor de provedor atualiza a partir das **versões marcadas** no GitHub (`v2026.11.25`, `v2026.11.25-2`…).
O `main` é desenvolvimento: só o servidor de teste (`CANAL=teste`) enxerga o `main`.

## Como funciona

1. Todo dia (e 10 min depois de ligar) o servidor consulta as versões no GitHub. **Não instala nada sozinho.**
2. No portal, **Configuração → Atualizações** mostra a versão instalada, as novas e o que mudou (`NOVIDADES.md`).
3. Quem está em `ATUALIZAR_USUARIOS` (no `.env` do portal; padrão `admin`) clica em **Atualizar**.
   O portal só deixa um pedido em `/var/lib/globaltech-atualizador/pedidos/`; quem instala é o serviço
   `globaltech-atualizador` (root), disparado pelo systemd.
4. A instalação (`atualizador/aplicar.sh` **da versão nova**):
   - confere tudo antes de mexer: sintaxe de todos os arquivos, o **portal novo ligado numa porta de teste** (3199, sem
     coleta das OLTs nem firmware) e a **simulação da publicação no ACS** (acusa variável nova faltando no `acs.env`);
   - roda as **migrações** da versão (`atualizador/migracoes/NNN-*.sh`, uma vez por servidor, com cópia do que mudam);
   - guarda cópia do que está instalado (`/var/lib/globaltech-atualizador/anterior/`);
   - ACS: extensões (reinicia o `genieacs-cwmp` só se mudaram) e depois provisions/presets/virtual parameters;
   - portal: troca as pastas e reinicia (~1 s). As sessões ficam gravadas: **ninguém é desconectado**;
   - confere que o portal voltou respondendo com a versão nova. **Se algo falhar, volta tudo** ao que estava.
5. O botão **Voltar para a versão anterior** reinstala a anterior pelo mesmo caminho.

Nunca são tocados: `.env` e `data/` do portal, `acs.env`, `sgp.env` (só por migração, com cópia), banco do GenieACS.

## Instalar num servidor que já existe

Como root, dentro de uma cópia do repositório (`git clone https://github.com/juninhogv11/globaltech-acs.git`):

```bash
bash atualizador/instalar-atualizador.sh                          # produção
CANAL=teste bash atualizador/instalar-atualizador.sh              # servidor de teste (vê também o main)
VERSAO_ATUAL=v2026.11.25 bash atualizador/instalar-atualizador.sh # se souber qual versão está instalada
```

Ele detecta o que há no servidor (portal em `/opt/globaltech-portal`, ACS em `/opt/genieacs`), cria
`/etc/globaltech-acs/atualizador.conf` e copia o `acs.env` para `/etc/globaltech-acs/acs.env`.
Instalações novas (`instalador/instalar.sh`) já fazem isso sozinhas.

**Portal e ACS em servidores separados:** instale o atualizador nos dois. O botão do portal atualiza o servidor do portal;
no servidor do ACS rode `globaltech-atualizar aplicar <versao>` (mesma versão).

## Linha de comando (root)

```bash
globaltech-atualizar verificar          # consulta o GitHub
globaltech-atualizar aplicar v2026.11.25
globaltech-atualizar voltar             # reinstala a versão anterior
globaltech-atualizar estado
journalctl -u globaltech-atualizador    # registro das execuções pedidas pelo portal
cat /var/lib/globaltech-atualizador/execucao.log
```

## Arquivos

| Onde | O quê |
|---|---|
| `/etc/globaltech-acs/atualizador.conf` | repositório, canal, partes instaladas neste servidor |
| `/etc/globaltech-acs/acs.env` | variáveis das provisions (vale para todas as versões) |
| `/opt/globaltech-atualizador/` | `atualizador.sh`, `estado.js` e as versões baixadas (3 últimas) |
| `/var/lib/globaltech-atualizador/` | `estado.json`, `execucao.json/.log` (o portal lê), `pedidos/`, `anterior/` (cópias) |
| `globaltech-atualizador.path/.service` | executa o pedido do portal |
| `globaltech-atualizador-verificar.timer` | consulta diária (06:00 + até 1 h) |
