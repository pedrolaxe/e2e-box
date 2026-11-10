package dev.e2ebox;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.UiAutomation;
import android.graphics.Rect;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.Bundle;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Base64;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Agente do e2e-box que roda no celular via app_process (sem APK):
 *
 *   adb push e2e-box-agent.jar /data/local/tmp/
 *   adb shell CLASSPATH=/data/local/tmp/e2e-box-agent.jar app_process / dev.e2ebox.Agent <socket> <segredo>
 *
 * Mantém uma conexão de UiAutomation aberta (a mesma que o `uiautomator dump` abre e fecha a
 * cada chamada) e atende num socket local abstrato <socket>, acessado do PC com
 * `adb forward tcp:N localabstract:<socket>`.
 *
 * Segurança (o agente lê a tela de qualquer app e escreve em campos, inclusive senha):
 * - só aceita conexão de shell (uid 2000, o adbd do `adb forward`) ou root;
 * - o nome do socket e o segredo são aleatórios por sessão, gerados no PC;
 * - antes de qualquer comando o cliente manda "hello <nonce> <HMAC(segredo, client:nonce)>" e o
 *   agente responde HMAC-SHA256(segredo, nonce): os dois lados provam que conhecem o segredo,
 *   e quem não conhece não passa do primeiro comando.
 *
 * Protocolo: uma linha por pedido; resposta "OK <bytes>\n<corpo>" ou "ERR <mensagem>\n".
 *   hello <nonce> <prova> -> OK, corpo HMAC-SHA256(segredo, nonce) em hex (obrigatório primeiro)
 *   ping              -> OK, corpo "pong"
 *   dump              -> XML no mesmo formato do uiautomator dump
 *   settext <base64>  -> acrescenta o texto (UTF-8) no campo focado, com acentos
 *   blur              -> tira o foco do campo; corpo "ok" ou "none" (nenhum campo focado)
 *   quit              -> encerra
 */
public final class Agent {
    private static final int SHELL_UID = 2000;
    private final String socketName;
    private final byte[] secret;
    private UiAutomation ua;

    private Agent(String socketName, String secret) {
        this.socketName = socketName;
        this.secret = secret.getBytes(StandardCharsets.UTF_8);
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2 || args[1].length() < 32) {
            System.out.println("ERROR uso: dev.e2ebox.Agent <socket> <segredo de 32+ caracteres>");
            System.exit(2);
        }
        // app_process não tem Looper principal, e o cliente de acessibilidade precisa de um.
        Looper.prepareMainLooper();
        Thread server = new Thread(() -> {
            try {
                new Agent(args[0], args[1]).run();
            } catch (Throwable e) {
                System.out.println("ERROR " + e);
                System.out.flush();
                System.exit(1);
            }
        }, "e2e-box-server");
        server.start();
        Looper.loop();
    }

    private void run() throws Exception {
        connect();
        LocalServerSocket server = new LocalServerSocket(socketName);
        System.out.println("READY " + socketName);
        System.out.flush();
        while (true) {
            final LocalSocket client = server.accept();
            int uid;
            try {
                uid = client.getPeerCredentials().getUid();
            } catch (Exception e) {
                uid = -1;
            }
            if (uid != SHELL_UID && uid != 0) {
                // Outro app do aparelho tentando falar com o agente.
                try {
                    client.close();
                } catch (Exception ignored) {
                    // nada a fazer
                }
                continue;
            }
            Thread t = new Thread(() -> serve(client));
            t.setDaemon(true);
            t.start();
        }
    }

    /** Mesmo caminho do uiautomator (UiAutomationShellWrapper), via reflexão: as classes são ocultas. */
    private void connect() throws Exception {
        HandlerThread thread = new HandlerThread("e2e-box-agent");
        thread.start();
        Class<?> connClass = Class.forName("android.app.UiAutomationConnection");
        Object connection = connClass.getDeclaredConstructor().newInstance();
        Class<?> iface = Class.forName("android.app.IUiAutomationConnection");
        Constructor<UiAutomation> ctor = UiAutomation.class.getDeclaredConstructor(Looper.class, iface);
        ctor.setAccessible(true);
        ua = ctor.newInstance(thread.getLooper(), connection);
        // FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES: não derruba TalkBack ou outros serviços ligados.
        Method connectWithFlags = UiAutomation.class.getDeclaredMethod("connect", int.class);
        connectWithFlags.setAccessible(true);
        connectWithFlags.invoke(ua, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES);

        AccessibilityServiceInfo info = ua.getServiceInfo();
        info.flags |= AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                | AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        ua.setServiceInfo(info);
    }

    private void serve(LocalSocket client) {
        try (LocalSocket c = client) {
            BufferedReader in = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
            OutputStream out = c.getOutputStream();
            // Primeira linha: "hello <nonce> <prova do cliente>". Sem ela, nenhum comando é atendido.
            // O cliente prova que conhece o segredo (HMAC de "client:"+nonce) e o agente responde
            // com o HMAC do nonce, provando o mesmo para o cliente.
            String first = in.readLine();
            String[] parts = first == null ? new String[0] : first.split(" ");
            if (parts.length != 3 || !parts[0].equals("hello") || parts[1].length() < 16
                    || !MessageDigest.isEqual(hmac("client:" + parts[1]).getBytes(StandardCharsets.UTF_8),
                            parts[2].getBytes(StandardCharsets.UTF_8))) {
                error(out, "handshake inválido");
                return;
            }
            reply(out, hmac(parts[1]));
            String line;
            while ((line = in.readLine()) != null) {
                try {
                    if (line.equals("ping")) {
                        reply(out, "pong");
                    } else if (line.equals("dump")) {
                        reply(out, dump());
                    } else if (line.startsWith("settext ")) {
                        String text = new String(Base64.decode(line.substring(8), Base64.DEFAULT), StandardCharsets.UTF_8);
                        reply(out, setText(text));
                    } else if (line.equals("blur")) {
                        reply(out, blur());
                    } else if (line.equals("quit")) {
                        reply(out, "bye");
                        System.exit(0);
                    } else {
                        error(out, "comando desconhecido: " + line);
                    }
                } catch (Throwable e) {
                    error(out, String.valueOf(e));
                }
            }
        } catch (Exception ignored) {
            // cliente desconectou
        }
    }

    private String hmac(String nonce) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret, "HmacSHA256"));
        byte[] sig = mac.doFinal(nonce.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(sig.length * 2);
        for (byte b : sig) hex.append(String.format("%02x", b & 0xff));
        return hex.toString();
    }

    private static void reply(OutputStream out, String body) throws Exception {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        synchronized (out) {
            out.write(("OK " + bytes.length + "\n").getBytes(StandardCharsets.UTF_8));
            out.write(bytes);
            out.flush();
        }
    }

    private static void error(OutputStream out, String message) {
        try {
            synchronized (out) {
                out.write(("ERR " + message.replace('\n', ' ') + "\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
        } catch (Exception ignored) {
            // nada a fazer
        }
    }

    // ---------- dump ----------

    /** Raiz da janela ativa; com teclado/diálogo de sistema na frente, cai para a janela do app. */
    private AccessibilityNodeInfo root() {
        AccessibilityNodeInfo root = ua.getRootInActiveWindow();
        if (root != null) return root;
        List<AccessibilityWindowInfo> windows = ua.getWindows();
        for (AccessibilityWindowInfo w : windows) {
            if (w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION && w.getRoot() != null) return w.getRoot();
        }
        return null;
    }

    private String dump() {
        AccessibilityNodeInfo root = null;
        for (int i = 0; i < 10 && root == null; i++) {
            root = root();
            if (root == null) sleep(50);
        }
        StringBuilder sb = new StringBuilder(64 * 1024);
        sb.append("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy");
        int rotation = rotation();
        if (rotation >= 0) sb.append(" rotation=\"").append(rotation).append('"');
        sb.append('>');
        if (root != null) node(sb, root, 0);
        sb.append("</hierarchy>");
        return sb.toString();
    }

    /** Rotação da tela principal (0–3), ou -1 se não der para ler: as classes são ocultas. */
    private static int rotation() {
        try {
            Class<?> global = Class.forName("android.hardware.display.DisplayManagerGlobal");
            Object manager = global.getMethod("getInstance").invoke(null);
            Object info = global.getMethod("getDisplayInfo", int.class).invoke(manager, 0);
            return info.getClass().getField("rotation").getInt(info);
        } catch (Throwable e) {
            return -1;
        }
    }

    private void node(StringBuilder sb, AccessibilityNodeInfo n, int index) {
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        sb.append("<node index=\"").append(index).append('"');
        attr(sb, "text", n.getText() != null && !(n.isShowingHintText()) ? n.getText() : "");
        attr(sb, "resource-id", n.getViewIdResourceName());
        attr(sb, "class", n.getClassName());
        attr(sb, "package", n.getPackageName());
        attr(sb, "content-desc", n.getContentDescription());
        attr(sb, "hint", n.getHintText());
        bool(sb, "checkable", n.isCheckable());
        bool(sb, "checked", n.isChecked());
        bool(sb, "clickable", n.isClickable());
        bool(sb, "enabled", n.isEnabled());
        bool(sb, "focusable", n.isFocusable());
        bool(sb, "focused", n.isFocused());
        bool(sb, "scrollable", n.isScrollable());
        bool(sb, "long-clickable", n.isLongClickable());
        bool(sb, "password", n.isPassword());
        bool(sb, "selected", n.isSelected());
        bool(sb, "editable", n.isEditable());
        sb.append(" bounds=\"[").append(r.left).append(',').append(r.top).append("][")
                .append(r.right).append(',').append(r.bottom).append("]\">");
        int childIndex = 0;
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo child = n.getChild(i);
            if (child == null) continue;
            // Igual ao uiautomator: pula o que não está visível para o usuário.
            if (child.isVisibleToUser()) node(sb, child, childIndex++);
        }
        sb.append("</node>");
    }

    private static void attr(StringBuilder sb, String name, CharSequence value) {
        sb.append(' ').append(name).append("=\"");
        if (value != null) escape(sb, value);
        sb.append('"');
    }

    private static void bool(StringBuilder sb, String name, boolean value) {
        sb.append(' ').append(name).append("=\"").append(value).append('"');
    }

    private static void escape(StringBuilder sb, CharSequence s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '&': sb.append("&amp;"); break;
                case '<': sb.append("&lt;"); break;
                case '>': sb.append("&gt;"); break;
                case '"': sb.append("&quot;"); break;
                case '\'': sb.append("&apos;"); break;
                case '\n': sb.append("&#10;"); break;
                case '\r': sb.append("&#13;"); break;
                case '\t': sb.append("&#9;"); break;
                default:
                    if (c >= 0x20 || c == 0x9) sb.append(c);
            }
        }
    }

    // ---------- texto ----------

    /** Acrescenta texto no campo focado (ACTION_SET_TEXT aceita qualquer caractere, inclusive acento). */
    private String setText(String text) {
        // O campo pode estar abrindo (tela de busca que abre por cima, teclado subindo):
        // tenta por até ~1,5s, relendo o campo focado a cada vez.
        String problem = "nenhum campo de texto focado";
        for (int attempt = 0; attempt < 15; attempt++) {
            if (attempt > 0) sleep(100);
            AccessibilityNodeInfo root = root();
            if (root == null) continue;
            AccessibilityNodeInfo field = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (field == null || !field.refresh() || !field.isEditable()) {
                problem = "nenhum campo de texto focado";
                continue;
            }
            CharSequence current = field.isShowingHintText() || field.getText() == null ? "" : field.getText();
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, current.toString() + text);
            if (field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return "ok";
            problem = "o campo recusou o texto";
        }
        throw new IllegalStateException(problem);
    }

    /** Tira o foco do campo atual (o app volta a receber o primeiro toque fora dele). */
    private String blur() {
        AccessibilityNodeInfo root = root();
        AccessibilityNodeInfo field = root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (field == null) return "none";
        if (!field.performAction(AccessibilityNodeInfo.ACTION_CLEAR_FOCUS)) throw new IllegalStateException("o campo recusou perder o foco");
        return "ok";
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
    }
}
