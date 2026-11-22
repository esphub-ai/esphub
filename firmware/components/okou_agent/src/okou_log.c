/*
 * ESP_LOG tee into a bounded RAM ring buffer.
 *
 * Writers (any task) take a spinlock for a short memcpy only and never wait for the
 * network; when the ring is full the line is dropped and counted, and a
 * "okou: dropped N log lines" line is inserted as soon as space is available again.
 * The agent task is the only reader: it sends lines in [sent, write) and releases
 * lines in [acked, sent) when the hub acks them (docs/protocol.md `log` / `ack`).
 *
 * SPDX-License-Identifier: MIT
 */
#include <stdio.h>
#include <string.h>
#include <stdarg.h>
#include <inttypes.h>
#include "freertos/FreeRTOS.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "sdkconfig.h"
#include "okou_priv.h"

typedef struct __attribute__((packed)) {
    uint32_t ms;
    uint16_t len;
    char level;
    uint8_t pad;
} rec_hdr_t;

#define HDR_SZ sizeof(rec_hdr_t)

static uint8_t *s_buf;
static uint32_t s_cap; /* power of two, so monotonic counters can wrap */
static uint32_t s_w, s_s, s_a; /* byte counters: write, sent, acked (tail) */
static uint32_t s_seq_w = 1, s_seq_s = 1, s_seq_a = 1;
static uint32_t s_dropped, s_dropped_total;
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static vprintf_like_t s_orig;

static void ring_put(uint32_t pos, const void *src, size_t n)
{
    uint32_t off = pos & (s_cap - 1);
    size_t first = n < (size_t)(s_cap - off) ? n : (size_t)(s_cap - off);
    memcpy(s_buf + off, src, first);
    if (n > first) {
        memcpy(s_buf, (const uint8_t *)src + first, n - first);
    }
}

static void ring_get(uint32_t pos, void *dst, size_t n)
{
    uint32_t off = pos & (s_cap - 1);
    size_t first = n < (size_t)(s_cap - off) ? n : (size_t)(s_cap - off);
    memcpy(dst, s_buf + off, first);
    if (n > first) {
        memcpy((uint8_t *)dst + first, s_buf, n - first);
    }
}

static bool push_locked(uint32_t ms, char level, const char *text, size_t len)
{
    size_t need = HDR_SZ + len;
    if ((size_t)(s_w - s_a) + need > s_cap) {
        return false;
    }
    rec_hdr_t h = {.ms = ms, .len = (uint16_t)len, .level = level, .pad = 0};
    ring_put(s_w, &h, HDR_SZ);
    ring_put(s_w + HDR_SZ, text, len);
    s_w += need;
    s_seq_w++;
    return true;
}

static size_t fmt_dropped(char *m, uint32_t n)
{
    static const char pre[] = "okou: dropped ";
    static const char post[] = " log lines (buffer full)";
    char digits[11];
    int d = 0;
    do {
        digits[d++] = (char)('0' + n % 10);
        n /= 10;
    } while (n && d < 10);
    size_t p = 0;
    memcpy(m, pre, sizeof(pre) - 1);
    p += sizeof(pre) - 1;
    while (d) {
        m[p++] = digits[--d];
    }
    memcpy(m + p, post, sizeof(post) - 1);
    p += sizeof(post) - 1;
    return p;
}

static void log_push(char level, const char *text, size_t len)
{
    if (!s_buf) {
        return;
    }
    if (len > CONFIG_OKOU_LOG_LINE_MAX) {
        len = CONFIG_OKOU_LOG_LINE_MAX;
    }
    uint32_t ms = (uint32_t)(esp_timer_get_time() / 1000);
    char m[64];
    portENTER_CRITICAL_SAFE(&s_mux);
    if (s_dropped) {
        size_t ml = fmt_dropped(m, s_dropped);
        if (push_locked(ms, 'W', m, ml)) {
            s_dropped = 0;
        } else {
            s_dropped++;
            s_dropped_total++;
            portEXIT_CRITICAL_SAFE(&s_mux);
            return;
        }
    }
    if (!push_locked(ms, level, text, len)) {
        s_dropped++;
        s_dropped_total++;
    }
    portEXIT_CRITICAL_SAFE(&s_mux);
}

/* "I (1234) tag: msg\n" -> level 'I', text "tag: msg". Anything else -> 'O'. */
static void capture(char *line, size_t n)
{
    char *p = line;
    char *end = line + n;
    if (p + 1 < end && p[0] == '\033' && p[1] == '[') { /* leading colour code */
        while (p < end && *p != 'm') {
            p++;
        }
        if (p < end) {
            p++;
        }
    }
    while (end > p && (end[-1] == '\n' || end[-1] == '\r')) {
        end--;
    }
    if (end - p >= 4 && end[-4] == '\033' && end[-3] == '[' && end[-1] == 'm') { /* trailing reset */
        end -= 4;
    }
    while (end > p && (end[-1] == '\n' || end[-1] == '\r')) {
        end--;
    }
    if (end <= p) {
        return;
    }
    char level = 'O';
    if (end - p > 3 && strchr("EWIDV", p[0]) && p[1] == ' ' && p[2] == '(') {
        char *q = memchr(p + 3, ')', (size_t)(end - p - 3));
        if (q && q + 1 < end && q[1] == ' ') {
            level = p[0];
            p = q + 2;
        }
    }
    log_push(level, p, (size_t)(end - p));
}

void okou_log_text(char level, const char *text, size_t len)
{
    while (len && (text[len - 1] == '\n' || text[len - 1] == '\r')) {
        len--;
    }
    if (len) {
        log_push(strchr("EWIDVO", level) ? level : 'O', text, len > CONFIG_OKOU_LOG_LINE_MAX ? CONFIG_OKOU_LOG_LINE_MAX : len);
    }
}

static int okou_vprintf(const char *fmt, va_list ap)
{
    char line[CONFIG_OKOU_LOG_LINE_MAX + 8];
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(line, sizeof(line), fmt, ap2);
    va_end(ap2);
    int r;
    if (s_orig == &vprintf && n >= 0 && n < (int)sizeof(line)) {
        r = fputs(line, stdout) >= 0 ? n : -1; /* avoid formatting twice */
    } else {
        r = s_orig(fmt, ap);
    }
    if (n > 0) {
        capture(line, n < (int)sizeof(line) ? (size_t)n : sizeof(line) - 1);
    }
    return r;
}

esp_err_t okou_log_init(void)
{
    if (s_buf) {
        return ESP_OK;
    }
    uint32_t cap = 1;
    while ((cap << 1) <= (uint32_t)CONFIG_OKOU_LOG_BUF_SIZE) {
        cap <<= 1;
    }
    s_buf = okou_malloc_large(cap);
    if (!s_buf) {
        return ESP_ERR_NO_MEM;
    }
    s_cap = cap;
    s_orig = esp_log_set_vprintf(okou_vprintf);
    if (!s_orig) {
        s_orig = &vprintf;
    }
    return ESP_OK;
}

size_t okou_log_build_frame(char *buf, size_t cap)
{
    portENTER_CRITICAL(&s_mux);
    uint32_t w = s_w;
    portEXIT_CRITICAL(&s_mux);
    if (!s_buf || s_s == w) {
        return 0;
    }
    int n = snprintf(buf, cap, "{\"t\":\"log\",\"seq\":%" PRIu32 ",\"lines\":[", s_seq_s);
    size_t pos = (size_t)n;
    int count = 0;
    char text[CONFIG_OKOU_LOG_LINE_MAX];
    while (s_s != w && count < 64) {
        rec_hdr_t h;
        ring_get(s_s, &h, HDR_SZ);
        size_t len = h.len;
        if (len > sizeof(text)) { /* corrupt - should not happen */
            len = sizeof(text);
        }
        ring_get(s_s + HDR_SZ, text, len);
        if (pos + len * 6 + 48 > cap) {
            break;
        }
        pos += (size_t)snprintf(buf + pos, cap - pos, "%s[%" PRIu32 ",\"%c\",\"", count ? "," : "", h.ms,
                                h.level);
        int e = okou_json_escape(buf + pos, cap - pos - 8, text, len);
        if (e < 0) {
            break; /* cannot happen given the worst-case check */
        }
        pos += (size_t)e;
        buf[pos++] = '"';
        buf[pos++] = ']';
        s_s += HDR_SZ + h.len;
        s_seq_s++;
        count++;
    }
    if (count == 0) {
        return 0;
    }
    buf[pos++] = ']';
    buf[pos++] = '}';
    buf[pos] = '\0';
    return pos;
}

void okou_log_ack(int64_t seq)
{
    while (s_seq_a < s_seq_s && (int64_t)s_seq_a <= seq) {
        rec_hdr_t h;
        ring_get(s_a, &h, HDR_SZ);
        portENTER_CRITICAL(&s_mux);
        s_a += HDR_SZ + h.len;
        s_seq_a++;
        portEXIT_CRITICAL(&s_mux);
    }
}

void okou_log_rewind(void)
{
    s_s = s_a;
    s_seq_s = s_seq_a;
}

void okou_log_stats(uint32_t *next_seq, uint32_t *sent_seq, uint32_t *acked_seq, uint32_t *dropped,
                    size_t *used, size_t *cap)
{
    portENTER_CRITICAL(&s_mux);
    *next_seq = s_seq_w;
    *sent_seq = s_seq_s;
    *acked_seq = s_seq_a;
    *dropped = s_dropped_total;
    *used = s_w - s_a;
    *cap = s_cap;
    portEXIT_CRITICAL(&s_mux);
}
