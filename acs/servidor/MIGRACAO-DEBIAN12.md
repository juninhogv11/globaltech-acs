# Migração do servidor GenieACS para Debian 12

Por que: o servidor atual está em **Debian 10.13** (sem atualizações de segurança desde 06/2024),
**MongoDB 4.4.15** (sem suporte desde 02/2024) e **Node.js 16.20.2** (sem suporte desde 09/2023).
O GenieACS é o **1.2.16**.

Estratégia: montar um **servidor novo** ao lado do atual, copiar os dados e trocar o IP no final.
O servidor antigo fica guardado (desligado) para voltar atrás se precisar.
Parada prevista na troca: ~15 minutos (os roteadores só tentam de novo no próximo inform).

| | Atual | Novo |
|---|---|---|
| Sistema | Debian 10.13 | Debian 12 |
| MongoDB | 4.4.15 | 7.0 |
| Node.js | 16.20.2 | 20 LTS |
| GenieACS | 1.2.16 | 1.2.16 (a mesma) |
| Máquina | 4 núcleos, 3,9 GB | 4 núcleos, **8 GB**, disco 40 GB+ |

---

## 0. Antes de começar (no servidor ATUAL)

Anote o que precisa ser recriado igual:

```bash
ip -4 addr; ip route                                  # IPs (172.16.0.139 e o da rede 192.168.10.x)
cat /etc/network/interfaces                           # configuração de rede
iptables-save > /root/firewall-atual.rules            # regras de firewall (NBI 7557 só para portal/SGP)
ls /etc/systemd/system/genieacs-*                      # arquivos dos serviços
crontab -l                                             # tarefas agendadas
```

Copie para fora do servidor (WinSCP): `/opt/genieacs/` inteiro (`ext/`, `genieacs.env`, `sgp.env`),
`/etc/systemd/system/genieacs-*.service`, `/root/firewall-atual.rules` e `/etc/network/interfaces`.

---

## 1. Servidor NOVO: sistema e verificação do processador

Instale Debian 12 (mínimo, com SSH). Depois:

```bash
grep -o -m1 avx /proc/cpuinfo || echo "SEM AVX"
```

**MongoDB 5 ou mais novo exige AVX.** Se aparecer "SEM AVX", no hypervisor mude o tipo de CPU da VM
para "host" (Proxmox: Hardware → Processors → Type = host) e confira de novo. Não siga sem AVX.

```bash
apt update && apt full-upgrade -y
apt install -y curl gnupg ca-certificates
```

## 2. MongoDB 7.0

```bash
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg
echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] http://repo.mongodb.org/apt/debian bookworm/mongodb-org/7.0 main" > /etc/apt/sources.list.d/mongodb-org-7.0.list
apt update && apt install -y mongodb-org
systemctl enable --now mongod
mongosh --quiet --eval 'db.runCommand({ping:1})'
```

## 3. Node.js 20 e GenieACS 1.2.16

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g genieacs@1.2.16
useradd --system --no-create-home --user-group genieacs
mkdir -p /opt/genieacs /var/log/genieacs
```

Copie de volta para o servidor novo: `/opt/genieacs/` (ext, genieacs.env, sgp.env) e os
`/etc/systemd/system/genieacs-*.service`. Confira os caminhos dentro dos `.service`
(`ExecStart=/usr/bin/genieacs-cwmp` etc.: `which genieacs-cwmp`).

```bash
chown -R genieacs:genieacs /opt/genieacs /var/log/genieacs
chmod 600 /opt/genieacs/genieacs.env /opt/genieacs/sgp.env
systemctl daemon-reload
```

Ainda **não** ligue os serviços do GenieACS.

## 4. Teste com uma cópia do banco (sem parar nada)

No servidor ATUAL:

```bash
mongodump --db genieacs --gzip --archive=/root/genieacs-teste.archive.gz
```

Leve o arquivo para o servidor NOVO e:

```bash
mongorestore --gzip --archive=/root/genieacs-teste.archive.gz --nsInclude 'genieacs.*' --drop
systemctl enable --now genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui
systemctl status genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui --no-pager | grep Active
curl -s 'http://127.0.0.1:7557/devices/?projection=_id' | head -c 300; echo
curl -s 'http://127.0.0.1:7557/files/' | head -c 300; echo
```

Confira: a interface (porta 3000) abre, as provisions/presets aparecem, os arquivos de firmware estão lá.
Os roteadores **ainda falam com o servidor antigo**: isso só testa a instalação.
Opcional: num roteador de teste, mude o `ManagementServer.URL` para o IP do servidor novo e veja o inform chegar.

Depois do teste, **desligue** os serviços do GenieACS no novo:

```bash
systemctl stop genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui
```

## 5. Troca (janela calma, fora de 03:00–05:00)

No servidor ATUAL:

```bash
systemctl stop genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui
mongodump --db genieacs --gzip --archive=/root/genieacs-final.archive.gz
```

No servidor NOVO:

```bash
mongorestore --gzip --archive=/root/genieacs-final.archive.gz --nsInclude 'genieacs.*' --drop
```

Troque os IPs: tire `172.16.0.139` (e o IP da rede 192.168.10.x usado pelo portal/SGP) do servidor
antigo e coloque no novo (`/etc/network/interfaces`). Reaplique o firewall
(`iptables-restore < /root/firewall-atual.rules`, e torne permanente com `apt install iptables-persistent`).
Assim os roteadores (`devacs.globaltech.inf.br`), o portal e o SGP continuam com os mesmos endereços.

```bash
systemctl enable --now genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui
cp genieacs-restart-semanal.service genieacs-restart-semanal.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now genieacs-restart-semanal.timer
```

## 6. Conferir depois da troca

- Em 5–10 minutos, a maioria dos aparelhos aparece "online" no portal (inform a cada 300 s).
- Página **Falhas** do portal: sem falhas novas.
- Portal: abrir um equipamento, "Atualizar agora", Wi-Fi e teste de velocidade funcionando.
- Restauração de Wi-Fi após reset: o portal só aceita o pedido do IP em `WIFI_BACKUP_ALLOW`
  (`/opt/globaltech-portal/.env`); se o IP do ACS mudou, ajuste lá.
- Na madrugada seguinte: `journalctl -u genieacs-cwmp --since "03:00" | grep REBOOT_PERIODICO`.

## Voltar atrás

Desligue o servidor novo e devolva os IPs ao antigo. Ligue os serviços do GenieACS no antigo.
O que mudou nos aparelhos durante o tempo no servidor novo se perde (só informação de leitura; os roteadores não são afetados).
Mantenha o antigo guardado por pelo menos 2 semanas.
