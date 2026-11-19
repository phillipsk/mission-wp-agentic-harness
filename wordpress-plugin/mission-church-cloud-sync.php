<?php
/**
 * Plugin Name: Mission Church Cloud Run Auto-Publisher & Sync Bridge
 * Description: Headless HMAC-SHA256 authenticated WordPress REST endpoints (/wp-json/mission/v1/publish and /wp-json/mission/v1/backup) deployed via Code Snippets for Cloud Run -> WordPress publishing (Posts + Modern Events Calendar + Media Sideloading).
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

/**
 * Resolve shared HMAC secret from server environment or WordPress options table.
 * Store via wp-config / env or `update_option('mission_sync_hmac_secret', '...')`.
 * Never hardcode production secrets in version-controlled source files.
 */
function mission_sync_secret() {
    $envSecret = getenv('MISSION_APPROVAL_SECRET');
    if (is_string($envSecret) && $envSecret !== '') {
        return trim($envSecret);
    }
    return trim((string) get_option('mission_sync_hmac_secret', ''));
}

function mission_verify_sig($req) {
    $s = mission_sync_secret();
    if ($s === '') {
        return false;
    }
    $sig = $req->get_header('x_mission_signature');
    if ($sig && hash_equals(hash_hmac('sha256', $req->get_body(), $s), strtolower(trim($sig)))) {
        return true;
    }
    $d = $req->get_header('x_approval_secret');
    return ($d && hash_equals($s, trim($d)));
}

add_action('rest_api_init', function () {
    register_rest_route('mission/v1', '/publish', array(
        'methods' => 'POST',
        'permission_callback' => function ($r) {
            return current_user_can('edit_posts') || mission_verify_sig($r);
        },
        'callback' => 'mission_cloud_publish_cb',
    ));
    register_rest_route('mission/v1', '/backup', array(
        'methods' => 'GET',
        'permission_callback' => function ($r) {
            return current_user_can('manage_options') || mission_verify_sig($r);
        },
        'callback' => 'mission_cloud_backup_cb',
    ));
});

function mission_sideload_img($d) {
    if (!function_exists('media_handle_sideload')) {
        require_once ABSPATH . 'wp-admin/includes/image.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/media.php';
    }
    $t = sanitize_text_field($d['title'] ?? 'Mission Event');
    if (!empty($d['imageBase64'])) {
        $m = sanitize_text_field($d['imageMimeType'] ?? 'image/jpeg');
        $ext = strpos($m, 'png') !== false ? 'png' : (strpos($m, 'webp') !== false ? 'webp' : 'jpg');
        $up = wp_upload_bits(sanitize_file_name($d['filename'] ?? ('mission-' . time() . '.' . $ext)), null, base64_decode($d['imageBase64']));
        if (empty($up['error']) && !empty($up['file'])) {
            $ft = wp_check_filetype($up['file'], null);
            $aid = wp_insert_attachment(array(
                'post_mime_type' => $ft['type'] ?: $m,
                'post_title' => $t,
                'post_content' => '',
                'post_status' => 'inherit',
            ), $up['file']);
            if (!is_wp_error($aid) && $aid) {
                wp_update_attachment_metadata($aid, wp_generate_attachment_metadata($aid, $up['file']));
                update_post_meta($aid, '_wp_attachment_image_alt', $t);
                return (int) $aid;
            }
        }
    } elseif (!empty($d['imageUrl']) && filter_var($d['imageUrl'], FILTER_VALIDATE_URL)) {
        $tmp = download_url(esc_url_raw($d['imageUrl']), 20);
        if (!is_wp_error($tmp)) {
            $ext = pathinfo((string) parse_url($d['imageUrl'], PHP_URL_PATH), PATHINFO_EXTENSION) ?: 'jpg';
            $id = media_handle_sideload(array(
                'name' => sanitize_file_name('mission-' . time() . '.' . $ext),
                'tmp_name' => $tmp,
            ), 0, $t);
            if (!is_wp_error($id)) {
                return (int) $id;
            }
            @unlink($tmp);
        }
    }
    return 0;
}

function mission_t2mec($ts, $dh) {
    $h24 = preg_match('/^(\d{1,2}):(\d{2})/', (string) $ts, $m) ? (int) $m[1] : (int) $dh;
    $min = isset($m[2]) ? sprintf('%02d', (int) $m[2]) : '00';
    return array(
        'hour' => (string) ($h24 % 12 ?: 12),
        'minutes' => $min,
        'ampm' => $h24 >= 12 ? 'PM' : 'AM',
        'seconds' => $h24 * 3600 + ((int) $min) * 60,
    );
}

function mission_cloud_publish_cb($req) {
    $d = $req->get_json_params() ?: array();
    $title = sanitize_text_field($d['title'] ?? '');
    if (!$title) {
        return new WP_REST_Response(array('error' => 'Title required'), 400);
    }
    $content = wp_kses_post($d['content'] ?? '');
    $excerpt = sanitize_textarea_field($d['excerpt'] ?? '');
    $st = in_array($d['status'] ?? 'draft', array('draft', 'publish', 'future'), true) ? $d['status'] : 'draft';
    $mid = mission_sideload_img($d);
    $res = array(
        'ok' => true,
        'featuredMediaId' => $mid ?: null,
        'featuredMediaUrl' => $mid ? wp_get_attachment_url($mid) : null,
    );
    if (!isset($d['createPost']) || $d['createPost']) {
        $pid = wp_insert_post(array(
            'post_type' => 'post',
            'post_title' => $title,
            'post_content' => $content,
            'post_excerpt' => $excerpt,
            'post_status' => $st,
            'post_author' => 2,
        ), true);
        if (!is_wp_error($pid)) {
            if ($mid) {
                set_post_thumbnail($pid, $mid);
            }
            $res['post'] = array(
                'id' => $pid,
                'status' => get_post_status($pid),
                'link' => get_permalink($pid),
                'editUrl' => admin_url("post.php?post={$pid}&action=edit"),
            );
        }
    }
    if (!isset($d['createMecEvent']) || $d['createMecEvent']) {
        $eid = wp_insert_post(array(
            'post_type' => 'mec-events',
            'post_title' => $title,
            'post_content' => $content,
            'post_excerpt' => $excerpt,
            'post_status' => $st,
            'post_author' => 2,
        ), true);
        if (!is_wp_error($eid)) {
            if ($mid) {
                set_post_thumbnail($eid, $mid);
            }
            $sd = preg_match('/^\d{4}-\d{2}-\d{2}$/', $d['startDate'] ?? '') ? $d['startDate'] : gmdate('Y-m-d');
            $ed = preg_match('/^\d{4}-\d{2}-\d{2}$/', $d['endDate'] ?? '') ? $d['endDate'] : $sd;
            $s = mission_t2mec($d['startTime'] ?? '12:00', 12);
            $e = mission_t2mec($d['endTime'] ?? '14:00', 14);
            $md = array(
                'start' => array('date' => $sd, 'hour' => $s['hour'], 'minutes' => $s['minutes'], 'ampm' => $s['ampm']),
                'end' => array('date' => $ed, 'hour' => $e['hour'], 'minutes' => $e['minutes'], 'ampm' => $e['ampm']),
                'allday' => 0,
                'hide_end_time' => 0,
            );
            update_post_meta($eid, 'mec_start_date', $sd);
            update_post_meta($eid, 'mec_end_date', $ed);
            update_post_meta($eid, 'mec_date', $md);
            update_post_meta($eid, 'mec_start_time_hour', $s['hour']);
            update_post_meta($eid, 'mec_start_time_minutes', $s['minutes']);
            update_post_meta($eid, 'mec_start_time_ampm', $s['ampm']);
            update_post_meta($eid, 'mec_start_day_seconds', $s['seconds']);
            update_post_meta($eid, 'mec_end_time_hour', $e['hour']);
            update_post_meta($eid, 'mec_end_time_minutes', $e['minutes']);
            update_post_meta($eid, 'mec_end_time_ampm', $e['ampm']);
            update_post_meta($eid, 'mec_end_day_seconds', $e['seconds']);
            update_post_meta($eid, 'mec_repeat_status', 0);
            update_post_meta($eid, 'mec_public', 1);
            global $wpdb;
            $t1 = $wpdb->prefix . 'mec_events';
            $t2 = $wpdb->prefix . 'mec_dates';
            if ($wpdb->get_var("SHOW TABLES LIKE '{$t1}'") === $t1) {
                $wpdb->replace($t1, array(
                    'post_id' => $eid,
                    'start' => $sd,
                    'repeat' => '',
                    'time_start' => $s['seconds'],
                    'time_end' => $e['seconds'],
                    'end' => $ed,
                ));
            }
            if ($wpdb->get_var("SHOW TABLES LIKE '{$t2}'") === $t2) {
                $wpdb->delete($t2, array('post_id' => $eid));
                $wpdb->insert($t2, array(
                    'post_id' => $eid,
                    'dstart' => $sd,
                    'dend' => $ed,
                    'tstart' => strtotime($sd . ' 12:00:00'),
                    'tend' => strtotime($ed . ' 14:00:00'),
                    'public' => 1,
                ));
            }
            $res['event'] = array(
                'id' => $eid,
                'status' => get_post_status($eid),
                'startDate' => $sd,
                'editUrl' => admin_url("post.php?post={$eid}&action=edit"),
            );
        }
    }
    if (function_exists('w3tc_flush_all')) {
        w3tc_flush_all();
    }
    return new WP_REST_Response($res, 200);
}

function mission_cloud_backup_cb() {
    if (!function_exists('get_plugins')) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    return new WP_REST_Response(array(
        'exportedAt' => gmdate('c'),
        'timezone' => get_option('timezone_string'),
        'activePlugins' => get_option('active_plugins', array()),
        'pages' => count(get_posts(array('post_type' => 'page', 'numberposts' => -1))),
        'posts' => count(get_posts(array('post_type' => 'post', 'numberposts' => -1))),
        'events' => count(get_posts(array('post_type' => 'mec-events', 'numberposts' => -1))),
    ), 200);
}
