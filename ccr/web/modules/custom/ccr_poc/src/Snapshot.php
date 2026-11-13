<?php

namespace Drupal\ccr_poc;

/**
 * Comparing what a slide said then with what it would say now.
 *
 * A generation log row records which content, which version, by whom and when.
 * "Which version" was a timestamp, which answers *whether* something moved but
 * never *what* — so the honest sentence a channel could say was "the record
 * behind this changed", and the quoted before/after on the collateral shelf was
 * hand-written prose.
 *
 * This makes it real. The renderer reports the lines it put on a slide
 * (`POST /values`, renderer/lib/values.js), the row keeps that list, and the
 * same question asked later gives a second list. The difference between them is
 * the drift, quoted.
 *
 * Two properties worth stating, because they are the reason to prefer this over
 * the timestamp:
 *
 * **It cannot over-report.** A save that changed a field no template shows —
 * the sixth pillar on a five-pillar slide, a typo in an unused field — produces
 * an empty difference, and the deck is correctly not stale. The timestamp
 * marked it stale every time.
 *
 * **It cannot get long.** Every slide-bound field is capped by its template
 * (title 60, positioning 180, a pillar description 80), and only the lines that
 * reached the slide are compared, so a whole slide is a few hundred characters
 * and a three-slide deck is a few dozen comparable lines. There is no
 * character-level diff here and there does not need to be one.
 *
 * Lines are matched by id, and the renderer keys item lines by the item's own
 * key rather than its position — so dragging a pillar reports nothing, which is
 * correct, instead of reporting every line below it as changed.
 */
class Snapshot {

  /**
   * The difference between two line lists, in the later list's own order.
   *
   * @param array $before
   *   Lines as `POST /values` returned them when the deck was generated.
   * @param array $after
   *   The same call made now.
   *
   * @return array<int, array{id: string, label: string, kind: string, was: ?string, now: ?string, was_text: ?string, now_text: ?string}>
   */
  public static function drift(array $before, array $after): array {
    $was = self::index($before);
    $now = self::index($after);

    $changes = [];
    foreach ($now as $id => $line) {
      if (!array_key_exists($id, $was)) {
        $changes[] = self::change($id, $line['label'], 'added', NULL, $line['value']);
      }
      elseif (($was[$id]['value'] ?? NULL) !== ($line['value'] ?? NULL)) {
        $changes[] = self::change($id, $line['label'], 'changed', $was[$id]['value'], $line['value']);
      }
    }
    foreach ($was as $id => $line) {
      if (!array_key_exists($id, $now)) {
        // A line the slide no longer has: the pillar it belonged to was
        // dropped, or the deck was rebuilt against a template that does not
        // show it. Worth saying — it is content the reader of the old file can
        // still see and will not find anywhere in the new one.
        $changes[] = self::change($id, $line['label'], 'removed', $line['value'], NULL);
      }
    }

    return $changes;
  }

  /**
   * The lines of a stored snapshot, or an empty list if there isn't one.
   *
   * Rows written before this existed have no snapshot, and there is no way to
   * reconstruct one — the file was made from content nobody kept. Those rows
   * fall back to the timestamp, and say so rather than reporting "no drift",
   * which would be a lie told confidently.
   */
  public static function lines(?string $json): array {
    if (!$json) {
      return [];
    }
    $decoded = json_decode($json, TRUE);
    return is_array($decoded['lines'] ?? NULL) ? $decoded['lines'] : [];
  }

  private static function index(array $lines): array {
    $out = [];
    foreach ($lines as $line) {
      if (isset($line['id'])) {
        $out[$line['id']] = $line;
      }
    }
    return $out;
  }

  /**
   * Both the markup and a plain-text rendering of it.
   *
   * The stored value carries `<strong>`/`<em>`, because bolding a word is a
   * change the slide shows and a comparison that ignored it would miss real
   * drift. But a channel showing the pair to a person should not have to run a
   * sanitiser to do it, so the text is offered alongside and the markup is
   * there for anything that wants to render the emphasis properly.
   */
  private static function change(string $id, string $label, string $kind, ?string $was, ?string $now): array {
    return [
      'id' => $id,
      'label' => $label,
      'kind' => $kind,
      'was' => $was,
      'now' => $now,
      'was_text' => $was === NULL ? NULL : self::plain($was),
      'now_text' => $now === NULL ? NULL : self::plain($now),
    ];
  }

  private static function plain(string $markup): string {
    return trim(html_entity_decode(strip_tags($markup), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
  }

}
