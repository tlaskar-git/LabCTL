# Host icons

Used as CSS masks (`css/icons.css`), so each icon takes the text colour of the theme. The SVG fill colour is ignored.

From simple-icons 16.34.0 (`npm pack simple-icons@16.34.0`, files `icons/<id>.svg`, copied unmodified, CC0 1.0, licence in
`LICENSE-simple-icons.md`): linux, debian, ubuntu, proxmox, apple, raspberrypi, docker, fedora, archlinux, centos, redhat,
suse, opensuse, alpinelinux, truenas, synology, vmware, kubernetes, homeassistant, pihole, adguard, nginx, traefikproxy,
wireguard, github. The names are trademarks of their owners and only identify the system a host runs.

Drawn for LabCTL (same licence as this repo): windows (four panes, simple-icons no longer ships Microsoft logos),
server, vps, router, database, shield, box, dc (domain controller).

To add one: put `<id>.svg` here, add the id to `ICON_IDS` in `server/src/host-icon.js`, to `ICONS` in
`public/js/components/os-icon.js` and a line to `css/icons.css`. `test/host-display.test.js` checks the three agree.
