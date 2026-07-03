#!/bin/sh
APPID=com.torrserver.app
luna-send -n 1 -w 60000 luna://com.webos.appInstallService/dev/remove "{\"id\":\"$APPID\"}" 2>/dev/null
sleep 6
luna-send -i -w 180000 luna://com.webos.appInstallService/dev/install "{\"id\":\"$APPID\",\"ipkUrl\":\"/media/internal/torrserver.ipk\",\"subscribe\":true}" >/tmp/ts-install.log 2>&1 &
LS=$!
i=0; APPDIR=""
while [ $i -lt 150 ]; do
  for b in /media/developer/apps/usr/palm/applications /media/cryptofs/apps/usr/palm/applications; do
    [ -d "$b/$APPID" ] && APPDIR="$b/$APPID"
  done
  [ -n "$APPDIR" ] && break
  sleep 1; i=$((i + 1))
done
sleep 8; kill $LS 2>/dev/null
if [ -n "$APPDIR" ]; then echo "INSTALL OK"; grep version "$APPDIR/appinfo.json" | head -n1; else echo "INSTALL FAILED"; tail -n 12 /tmp/ts-install.log; fi
for p in /media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service /media/cryptofs/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service; do
  [ -x "$p" ] && "$p" com.torrserver.app.service >/dev/null 2>&1 && echo "elevated" && break
done
sleep 2
luna-send -n 1 -w 15000 luna://com.webos.applicationManager/launch '{"id":"com.torrserver.app"}'
echo ""
sleep 6
curl -s -m 4 http://127.0.0.1:9998/json/list 2>&1 | grep -o '"id": "[^"]*"' | head -1
true
