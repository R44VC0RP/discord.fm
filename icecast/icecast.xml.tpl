<icecast>
    <location>the anomaly</location>
    <admin>admin@${ICECAST_HOSTNAME}</admin>
    <hostname>${ICECAST_HOSTNAME}</hostname>

    <limits>
        <clients>${ICECAST_MAX_CLIENTS}</clients>
        <sources>4</sources>
        <queue-size>524288</queue-size>
        <client-timeout>30</client-timeout>
        <header-timeout>15</header-timeout>
        <source-timeout>10</source-timeout>
        <!-- Burst gets new listeners playing quickly at the cost of latency. -->
        <burst-on-connect>1</burst-on-connect>
        <burst-size>65535</burst-size>
    </limits>

    <authentication>
        <source-password>${ICECAST_SOURCE_PASSWORD}</source-password>
        <relay-password>${ICECAST_RELAY_PASSWORD}</relay-password>
        <admin-user>admin</admin-user>
        <admin-password>${ICECAST_ADMIN_PASSWORD}</admin-password>
    </authentication>

    <listen-socket>
        <port>8000</port>
    </listen-socket>

    <http-headers>
        <header name="Access-Control-Allow-Origin" value="*" />
    </http-headers>

    <fileserve>1</fileserve>

    <paths>
        <basedir>/usr/share/icecast2</basedir>
        <logdir>/var/log/icecast2</logdir>
        <webroot>/usr/share/icecast2/web</webroot>
        <adminroot>/usr/share/icecast2/admin</adminroot>
        <!-- Root serves the station player. -->
        <alias source="/" destination="/station/player.html"/>
    </paths>

    <logging>
        <accesslog>access.log</accesslog>
        <errorlog>error.log</errorlog>
        <loglevel>3</loglevel>
        <logsize>10000</logsize>
        <logarchive>0</logarchive>
    </logging>

    <security>
        <chroot>0</chroot>
    </security>
</icecast>
